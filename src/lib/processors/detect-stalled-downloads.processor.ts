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
import { normalizeReleaseKey } from '../utils/release-key';

export interface DetectStalledDownloadsPayload {
  jobId?: string;
  scheduledJobId?: string;
}

const DEFAULT_TIMEOUT_DAYS = 7;
const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_MAX_PROGRESS = 50; // Only swap if progress is BELOW this percent
const DEFAULT_GLOBAL_THRESHOLD = 3; // Promote to global block after N independent stalls

const CONFIG_KEY_TIMEOUT_DAYS = 'automation.stall_timeout_days';
const CONFIG_KEY_MAX_PROGRESS = 'automation.stall_swap_max_progress';
const CONFIG_KEY_GLOBAL_THRESHOLD = 'automation.global_block_threshold';

// Reason prefix used by both the processor (when writing blocks) and the
// counter (when finding past stalls of the same release).
const STALL_REASON_PREFIX = 'Stalled timeout';

function parseTimeoutDays(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_DAYS;
  // Clamp to sane bounds: minimum 1 day, max 365 days
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

function parseMaxProgress(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_MAX_PROGRESS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_PROGRESS;
  return Math.min(Math.max(Math.floor(n), 0), 100);
}

function parseGlobalThreshold(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_GLOBAL_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GLOBAL_THRESHOLD;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

export async function processDetectStalledDownloads(
  payload: DetectStalledDownloadsPayload
): Promise<any> {
  const { jobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'DetectStalledDownloads');

  try {
    const configService = getConfigService();
    const [timeoutRaw, maxProgressRaw, globalThresholdRaw] = await Promise.all([
      configService.get(CONFIG_KEY_TIMEOUT_DAYS),
      configService.get(CONFIG_KEY_MAX_PROGRESS),
      configService.get(CONFIG_KEY_GLOBAL_THRESHOLD),
    ]);
    const timeoutDays = parseTimeoutDays(timeoutRaw);
    const maxProgress = parseMaxProgress(maxProgressRaw);
    const globalThreshold = parseGlobalThreshold(globalThresholdRaw);
    const cutoff = new Date(Date.now() - timeoutDays * 24 * 60 * 60 * 1000);

    logger.info(
      `Scanning for stalled downloads (timeout=${timeoutDays}d, maxProgress=${maxProgress}%, globalThreshold=${globalThreshold})`,
      { cutoffIso: cutoff.toISOString() }
    );

    // Only requests currently in `downloading` status whose latest selected
    // DownloadHistory started before the cutoff. We intentionally do NOT touch
    // `processing` / `downloaded` / `available` — those have moved past the
    // download phase even if other steps later failed.
    //
    // Progress gate is applied here in the query, not after — anything at/above
    // `maxProgress` is given more grace (probably just needs peers) and won't
    // be swapped this run. Admins can dial maxProgress=100 to swap aggressively.
    const stalled = await prisma.request.findMany({
      where: {
        status: 'downloading',
        deletedAt: null,
        progress: { lt: maxProgress },
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
        maxProgress,
        globalThreshold,
        swapped: 0,
        failed: 0,
        skipped: 0,
        promotedToGlobal: 0,
      };
    }

    logger.info(`Found ${stalled.length} stalled requests (capped at ${DEFAULT_MAX_PER_RUN}/run)`);

    const jobQueue = getJobQueueService();
    const clientManager = getDownloadClientManager(configService);

    let swapped = 0;
    let failed = 0;
    let skipped = 0;
    let promotedToGlobal = 0;

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
        //    After writing the per-request block, count how many independent
        //    stalls this release has accumulated. If we've crossed the
        //    `globalThreshold`, promote ALL matching rows to global=true so
        //    filter-blocked-results strips the release from every future search.
        if (dh.torrentName) {
          const releaseKey = normalizeReleaseKey(dh.torrentName);

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

          const stallCount = await prisma.blockedRelease.count({
            where: {
              releaseKey,
              source: 'download_fail',
              reason: { startsWith: STALL_REASON_PREFIX },
            },
          });

          if (stallCount >= globalThreshold) {
            const promoted = await prisma.blockedRelease.updateMany({
              where: {
                releaseKey,
                source: 'download_fail',
                reason: { startsWith: STALL_REASON_PREFIX },
                global: false,
              },
              data: { global: true },
            });
            if (promoted.count > 0) {
              promotedToGlobal += promoted.count;
              logger.info(`Promoted release to GLOBAL block`, {
                releaseKey,
                stallCount,
                globalThreshold,
                rowsPromoted: promoted.count,
              });
            }
          }
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
      promotedToGlobal,
      timeoutDays,
      maxProgress,
      globalThreshold,
    });

    return {
      success: true,
      message: 'Detect stalled downloads completed',
      timeoutDays,
      maxProgress,
      globalThreshold,
      totalChecked: stalled.length,
      swapped,
      failed,
      skipped,
      promotedToGlobal,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
