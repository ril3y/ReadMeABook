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
// Stage 1 cap stays conservative — each swap fires a fresh indexer search,
// so 50/hr is the right ceiling to avoid Prowlarr storms.
const DEFAULT_MAX_PER_RUN = 50;
// Stage 2 is pure qBT cleanup (no DB writes beyond logging, no indexer load),
// so it can go much higher. 500/run drains a typical post-migration backlog
// of 1.5–2k orphans in 3–4 passes.
const STAGE2_MAX_PER_RUN = 500;
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

    logger.info(`Stage 1: ${stalled.length} stalled requests found (capped at ${DEFAULT_MAX_PER_RUN}/run)`);

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

    logger.info(`Stage 1 (request-side) complete`, {
      totalChecked: stalled.length,
      swapped,
      failed,
      skipped,
      promotedToGlobal,
      timeoutDays,
      maxProgress,
      globalThreshold,
    });

    // -----------------------------------------------------------------------
    // STAGE 2 — qBT-direct orphan + stale scan.
    //
    // Stage 1 only sees requests whose status is still `downloading`. In
    // practice (post-migration / after monitor-download connection-failure
    // exhaustion), torrents keep loitering in qBT while their backing Request
    // has already flipped to `awaiting_search` or never existed (Readarr-era
    // orphans). Those are invisible to Stage 1 even though they're the bulk
    // of "stuck" torrents. Stage 2 closes that gap:
    //   - Walks the full torrent client torrent list
    //   - Finds torrents added before the cutoff that are not actively
    //     downloading (no progress AND no speed, or in failed state)
    //   - Cross-references against DownloadHistory by torrent hash
    //   - Three buckets:
    //       (a) Orphan: no DH row at all -> delete with files
    //       (b) Stale-linked: DH row exists but Request is gone (soft-deleted)
    //           or in a non-downloading status -> delete with files
    //       (c) Owned by a request still in `downloading` -> Stage 1 already
    //           handled it; skip to avoid double-action
    //
    // Cap is STAGE2_MAX_PER_RUN (500 by default) — high enough to drain a
    // post-migration backlog in a few hourly passes, low enough that one run
    // doesn't lock qBT's UI under a torrent of REST calls.
    // -----------------------------------------------------------------------

    let orphansDeleted = 0;
    let staleLinkedDeleted = 0;
    let qbtScanErrors = 0;

    try {
      const torrentClient = await clientManager.getClientServiceForProtocol('torrent');
      if (!torrentClient) {
        logger.info('No torrent client configured — skipping Stage 2');
      } else {
        const allTorrents = await torrentClient.listDownloads();
        const candidates = allTorrents.filter(t => {
          if (!t.addedAt || t.addedAt >= cutoff) return false;
          if (t.progress >= 1) return false; // already complete
          // Stalled: in failed state (missingFiles/error), OR no traffic on a
          // download that isn't complete. Skip actively-seeding torrents
          // (status: 'seeding') even if added long ago.
          if (t.status === 'failed') return true;
          if (t.status === 'downloading' && t.downloadSpeed === 0) return true;
          return false;
        });

        logger.info(`Stage 2: ${allTorrents.length} torrents in client, ${candidates.length} stalled past cutoff`);

        if (candidates.length > 0) {
          const hashes = candidates.map(t => t.id.toLowerCase());
          // One bulk lookup instead of N queries — much faster on large sets.
          // We grab enough fields to (a) classify orphan vs stale-linked, and
          // (b) reuse the Stage 1 swap pattern (block + search) when the
          // backing Request is still in `awaiting_search` — closes the
          // "deleted the torrent but RMAB doesn't know to find a replacement"
          // gap by mirroring the same block-and-research flow.
          const dhRows = await prisma.downloadHistory.findMany({
            where: { torrentHash: { in: hashes } },
            select: {
              id: true,
              torrentHash: true,
              torrentName: true,
              nzbId: true,
              indexerName: true,
              indexerId: true,
              request: {
                select: {
                  id: true,
                  status: true,
                  type: true,
                  deletedAt: true,
                  audiobook: {
                    select: { id: true, title: true, author: true, audibleAsin: true },
                  },
                },
              },
            },
          });
          const dhByHash = new Map<string, typeof dhRows[number]>();
          for (const dh of dhRows) {
            if (dh.torrentHash) dhByHash.set(dh.torrentHash.toLowerCase(), dh);
          }

          const cap = Math.min(candidates.length, STAGE2_MAX_PER_RUN);
          for (let i = 0; i < cap; i++) {
            const t = candidates[i];
            try {
              const dh = dhByHash.get(t.id.toLowerCase());
              const requestStatus = dh?.request?.status;
              const requestDeleted = dh?.request?.deletedAt != null;

              // (c) Owned by an active downloading request — Stage 1 territory.
              if (dh && !requestDeleted && requestStatus === 'downloading') {
                continue;
              }

              // For stale-linked rows where the backing Request is still
              // actively waiting on a new release (`awaiting_search`), do the
              // full Stage-1-style swap BEFORE deleting the torrent: block
              // the dead release, count toward the global threshold, and
              // queue a fresh search. Without this step, retry-missing-torrents
              // would re-grab the same stalled torrent on its next pass.
              //
              // The block/search step is wrapped in its OWN try/catch so a
              // transient Redis or DB blip can't strand the qBT torrent —
              // the delete in the `finally` below always runs. Worst case:
              // we lose the block-and-research on this pass; the orphan
              // torrent is still cleaned out of qBT.
              let reSearched = false;
              if (dh && !requestDeleted && requestStatus === 'awaiting_search' && dh.request && dh.torrentName) {
                try {
                  const stalledDays = t.addedAt
                    ? Math.floor((Date.now() - t.addedAt.getTime()) / (24 * 60 * 60 * 1000))
                    : timeoutDays;
                  const reason = `Stalled timeout (${stalledDays}d, threshold ${timeoutDays}d)`;
                  const releaseKey = normalizeReleaseKey(dh.torrentName);

                  await addAutoBlock({
                    requestId: dh.request.id,
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

                  // Promote to global if threshold reached (same as Stage 1)
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
                    }
                  }

                  // Queue a fresh search now (don't wait for daily retry-missing-torrents).
                  if (dh.request.audiobook) {
                    if (dh.request.type === 'ebook') {
                      await jobQueue.addSearchEbookJob(dh.request.id, {
                        id: dh.request.audiobook.id,
                        title: dh.request.audiobook.title,
                        author: dh.request.audiobook.author,
                        asin: dh.request.audiobook.audibleAsin || undefined,
                      });
                    } else {
                      await jobQueue.addSearchJob(dh.request.id, {
                        id: dh.request.audiobook.id,
                        title: dh.request.audiobook.title,
                        author: dh.request.audiobook.author,
                        asin: dh.request.audiobook.audibleAsin || undefined,
                      });
                    }
                  }
                  reSearched = true;
                } catch (blockErr) {
                  qbtScanErrors++;
                  logger.warn(`Stage 2: block-and-research failed, still deleting torrent`, {
                    hash: t.id,
                    requestId: dh.request.id,
                    error: blockErr instanceof Error ? blockErr.message : String(blockErr),
                  });
                }
              }

              // Always delete the torrent from qBT (with files), regardless
              // of whether the block/research path above succeeded.
              await torrentClient.deleteDownload(t.id, true);
              if (!dh) {
                orphansDeleted++;
                logger.info(`Stage 2: deleted orphan torrent (no DH)`, {
                  hash: t.id,
                  name: t.name,
                  category: t.category,
                  addedAt: t.addedAt?.toISOString(),
                });
              } else {
                staleLinkedDeleted++;
                logger.info(`Stage 2: deleted stale-linked torrent`, {
                  hash: t.id,
                  name: t.name,
                  requestStatus: requestStatus ?? 'request-deleted',
                  reSearched,
                  addedAt: t.addedAt?.toISOString(),
                });
              }
            } catch (err) {
              qbtScanErrors++;
              logger.warn(`Stage 2: failed to handle torrent`, {
                hash: t.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
    } catch (err) {
      qbtScanErrors++;
      logger.error(`Stage 2 scan failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info(`Pass complete`, {
      stage1: { swapped, failed, skipped, promotedToGlobal },
      stage2: { orphansDeleted, staleLinkedDeleted, qbtScanErrors },
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
      orphansDeleted,
      staleLinkedDeleted,
      qbtScanErrors,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
