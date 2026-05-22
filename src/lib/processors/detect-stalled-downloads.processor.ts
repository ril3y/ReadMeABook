/**
 * Component: Detect Stalled Downloads Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Auto-swaps releases for downloads that have been in progress longer than
 * `automation.stall_timeout_days` without completing. Existing scheduler
 * coverage (retry-missing-torrents / monitor-download) only handles the
 * search-and-grab side; active downloads that never finish stay pinned to
 * `downloading` forever. This processor closes that gap:
 *
 *   1. Query `Request.status='downloading'` with `progress<100` whose latest
 *      selected `DownloadHistory.startedAt` is older than the timeout.
 *   2. Tell the download client to delete the torrent + files.
 *   3. Block the release via the existing BlockedRelease table so the same
 *      torrent isn't re-grabbed on retry.
 *   4. Reset the request back to `awaiting_search` and queue a fresh search.
 *
 * Per-run cap (DEFAULT_MAX_PER_RUN) prevents an "all 2,500 stuck downloads
 * at once" indexer storm on first deploy — the backlog drains across several
 * hourly runs instead.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getJobQueueService } from '../services/job-queue.service';
import { getConfigService } from '../services/config.service';
import { addAutoBlock } from '../services/blocklist.service';
import { getDownloadClientManager } from '../services/download-client-manager.service';
import { CLIENT_PROTOCOL_MAP, DownloadClientType } from '../interfaces/download-client.interface';

export interface DetectStalledDownloadsPayload {
  jobId?: string;
  scheduledJobId?: string;
}

const DEFAULT_TIMEOUT_DAYS = 7;
const DEFAULT_MAX_PER_RUN = 50;
const CONFIG_KEY_TIMEOUT_DAYS = 'automation.stall_timeout_days';

function parseTimeoutDays(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_DAYS;
  // Clamp to sane bounds: minimum 1 day, max 365 days
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

export async function processDetectStalledDownloads(
  payload: DetectStalledDownloadsPayload
): Promise<any> {
  const { jobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'DetectStalledDownloads');

  try {
    const configService = getConfigService();
    const timeoutDays = parseTimeoutDays(await configService.get(CONFIG_KEY_TIMEOUT_DAYS));
    const cutoff = new Date(Date.now() - timeoutDays * 24 * 60 * 60 * 1000);

    logger.info(`Scanning for downloads stalled before ${cutoff.toISOString()} (timeout=${timeoutDays}d)`);

    // Only requests currently in `downloading` status whose latest selected
    // DownloadHistory started before the cutoff. We intentionally do NOT touch
    // `processing` / `downloaded` / `available` — those have moved past the
    // download phase even if other steps later failed.
    const stalled = await prisma.request.findMany({
      where: {
        status: 'downloading',
        deletedAt: null,
        progress: { lt: 100 },
        downloadHistory: {
          some: {
            selected: true,
            startedAt: { lt: cutoff },
          },
        },
      },
      include: {
        audiobook: true,
        downloadHistory: {
          where: { selected: true },
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
      take: DEFAULT_MAX_PER_RUN,
    });

    if (stalled.length === 0) {
      logger.info('No stalled downloads found');
      return {
        success: true,
        message: 'No stalled downloads',
        timeoutDays,
        swapped: 0,
        failed: 0,
        skipped: 0,
      };
    }

    logger.info(`Found ${stalled.length} stalled requests (capped at ${DEFAULT_MAX_PER_RUN}/run)`);

    const jobQueue = getJobQueueService();
    const clientManager = getDownloadClientManager(configService);

    let swapped = 0;
    let failed = 0;
    let skipped = 0;

    for (const request of stalled) {
      try {
        const dh = request.downloadHistory[0];
        if (!dh) {
          skipped++;
          continue;
        }

        const stalledDays = dh.startedAt
          ? Math.floor((Date.now() - dh.startedAt.getTime()) / (24 * 60 * 60 * 1000))
          : timeoutDays;
        const reason = `Stalled timeout (${stalledDays}d, threshold ${timeoutDays}d)`;

        // 1. Best-effort delete from the download client. A failure here must
        //    not block the rest of the swap — the torrent may already be gone
        //    from the client and the orphan will get cleaned up later.
        if (dh.downloadClientId && dh.downloadClient) {
          const protocol = CLIENT_PROTOCOL_MAP[dh.downloadClient as DownloadClientType];
          if (protocol) {
            try {
              const client = await clientManager.getClientServiceForProtocol(protocol);
              if (client) {
                await client.deleteDownload(dh.downloadClientId, true);
                logger.info(`Deleted stalled download from ${dh.downloadClient}`, {
                  requestId: request.id,
                  downloadClientId: dh.downloadClientId,
                });
              }
            } catch (err) {
              logger.warn(`Failed to delete download from client (continuing with swap)`, {
                requestId: request.id,
                downloadClientId: dh.downloadClientId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // 2. Block the release so the same torrent isn't re-grabbed.
        //    addAutoBlock never throws — it's safe to call unconditionally.
        if (dh.torrentName) {
          await addAutoBlock({
            requestId: request.id,
            releaseName: dh.torrentName,
            releaseHash: dh.torrentHash ?? dh.nzbId ?? null,
            indexerName: dh.indexerName ?? null,
            indexerId: dh.indexerId ?? null,
            source: 'download_fail',
            reason,
            reasonDetail: null,
            downloadHistoryId: dh.id,
            jobId,
          });
        }

        // 3. Mark the DH row as failed for history visibility.
        await prisma.downloadHistory.update({
          where: { id: dh.id },
          data: {
            downloadStatus: 'failed',
            downloadError: reason,
          },
        });

        // 4. Flip the request back to awaiting_search and queue a fresh search.
        //    Reset progress so the UI doesn't show a stale percentage.
        await prisma.request.update({
          where: { id: request.id },
          data: {
            status: 'awaiting_search',
            progress: 0,
            errorMessage: `Auto-swapped after ${stalledDays}d stall`,
          },
        });

        if (request.type === 'ebook') {
          await jobQueue.addSearchEbookJob(request.id, {
            id: request.audiobook.id,
            title: request.audiobook.title,
            author: request.audiobook.author,
            asin: request.audiobook.audibleAsin || undefined,
          });
        } else {
          await jobQueue.addSearchJob(request.id, {
            id: request.audiobook.id,
            title: request.audiobook.title,
            author: request.audiobook.author,
            asin: request.audiobook.audibleAsin || undefined,
          });
        }

        swapped++;
        logger.info(`Swapped stalled download`, {
          requestId: request.id,
          audiobookTitle: request.audiobook.title,
          stalledDays,
          releaseName: dh.torrentName ?? null,
        });
      } catch (error) {
        failed++;
        logger.error(`Failed to swap stalled download`, {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Spread DB operations to avoid connection pool exhaustion (same pattern
      // as retry-missing-torrents.processor.ts).
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(`Stall-swap pass complete`, {
      totalChecked: stalled.length,
      swapped,
      failed,
      skipped,
      timeoutDays,
    });

    return {
      success: true,
      message: 'Detect stalled downloads completed',
      timeoutDays,
      totalChecked: stalled.length,
      swapped,
      failed,
      skipped,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
