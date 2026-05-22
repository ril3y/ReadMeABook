/**
 * Component: Admin Stalled Downloads API
 * Documentation: documentation/admin-features/stalled-downloads.md
 *
 * Read-only view of the detect-stalled-downloads processor:
 *   - Current `automation.stall_timeout_days` setting and the resolved cutoff
 *   - Last/next scheduled run of `detect_stalled_downloads`
 *   - Currently-stalled requests (status='downloading', stuck longer than cutoff)
 *   - Recent auto-swaps (BlockedRelease rows from this processor)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.StalledDownloads');

const CONFIG_KEY_TIMEOUT = 'automation.stall_timeout_days';
const CONFIG_KEY_MAX_PROGRESS = 'automation.stall_swap_max_progress';
const CONFIG_KEY_GLOBAL_THRESHOLD = 'automation.global_block_threshold';
const DEFAULT_TIMEOUT_DAYS = 7;
const DEFAULT_MAX_PROGRESS = 50;
const DEFAULT_GLOBAL_THRESHOLD = 3;
const STALL_REASON_PREFIX = 'Stalled timeout';

function parseTimeoutDays(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_DAYS;
  return Math.min(Math.max(n, 1), 365);
}

function parseMaxProgress(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_MAX_PROGRESS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_PROGRESS;
  return Math.min(Math.max(n, 0), 100);
}

function parseGlobalThreshold(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_GLOBAL_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GLOBAL_THRESHOLD;
  return Math.min(Math.max(n, 1), 100);
}

export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const configService = getConfigService();
        const [tRaw, pRaw, gRaw] = await Promise.all([
          configService.get(CONFIG_KEY_TIMEOUT),
          configService.get(CONFIG_KEY_MAX_PROGRESS),
          configService.get(CONFIG_KEY_GLOBAL_THRESHOLD),
        ]);
        const timeoutDays = parseTimeoutDays(tRaw);
        const stallSwapMaxProgress = parseMaxProgress(pRaw);
        const globalBlockThreshold = parseGlobalThreshold(gRaw);
        const cutoff = new Date(Date.now() - timeoutDays * 24 * 60 * 60 * 1000);

        // Scheduled job metadata (last/next run, enabled flag).
        const scheduledJob = await prisma.scheduledJob.findFirst({
          where: { type: 'detect_stalled_downloads' },
        });

        // Currently stalled: same predicate as the processor itself —
        // honors the maxProgress gate so the UI matches what will actually swap.
        // Limited to first 100 for the dashboard list; full count comes from
        // a parallel count query so the UI can show "showing 100 of 247".
        const [currentlyStalled, currentlyStalledCount] = await Promise.all([
          prisma.request.findMany({
            where: {
              status: 'downloading',
              deletedAt: null,
              progress: { lt: stallSwapMaxProgress },
              downloadHistory: {
                some: {
                  selected: true,
                  startedAt: { lt: cutoff },
                },
              },
            },
            include: {
              audiobook: {
                select: { id: true, title: true, author: true, coverArtUrl: true },
              },
              downloadHistory: {
                where: { selected: true },
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  torrentName: true,
                  indexerName: true,
                  startedAt: true,
                  downloadStatus: true,
                  downloadClient: true,
                },
              },
            },
            orderBy: { updatedAt: 'asc' }, // longest-stuck first
            take: 100,
          }),
          prisma.request.count({
            where: {
              status: 'downloading',
              deletedAt: null,
              progress: { lt: stallSwapMaxProgress },
              downloadHistory: {
                some: {
                  selected: true,
                  startedAt: { lt: cutoff },
                },
              },
            },
          }),
        ]);

        // Recent swaps — BlockedRelease rows from THIS processor.
        // Matched by source + reason-prefix so we don't surface monitor-download's
        // failure rows (which also use source='download_fail' but a different reason).
        const recentSwaps = await prisma.blockedRelease.findMany({
          where: {
            source: 'download_fail',
            reason: { startsWith: STALL_REASON_PREFIX },
          },
          include: {
            request: {
              select: {
                id: true,
                status: true,
                type: true,
                audiobook: {
                  select: { id: true, title: true, author: true, coverArtUrl: true },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });

        // Sample of all currently downloading (any age) for context — gives admins
        // a sense of "how many normal downloads vs how many stalled".
        const activeDownloadingTotal = await prisma.request.count({
          where: { status: 'downloading', deletedAt: null },
        });

        // Globally-blocked releases (cross-request). Group by releaseKey so
        // the UI shows one row per release even if multiple requests stalled
        // on it. Limited to top 50 by most-recent.
        const globalBlocks = await prisma.blockedRelease.findMany({
          where: { global: true },
          orderBy: { createdAt: 'desc' },
          select: {
            releaseKey: true,
            releaseName: true,
            releaseHash: true,
            indexerName: true,
            reason: true,
            createdAt: true,
          },
        });
        // Dedup by releaseKey, keep first (most recent) occurrence, count siblings.
        const globalByKey = new Map<string, {
          releaseKey: string;
          releaseName: string;
          releaseHash: string | null;
          indexerName: string | null;
          reason: string;
          firstSeenAt: string;
          stallCount: number;
        }>();
        for (const b of globalBlocks) {
          const existing = globalByKey.get(b.releaseKey);
          if (existing) {
            existing.stallCount += 1;
            continue;
          }
          globalByKey.set(b.releaseKey, {
            releaseKey: b.releaseKey,
            releaseName: b.releaseName,
            releaseHash: b.releaseHash,
            indexerName: b.indexerName,
            reason: b.reason,
            firstSeenAt: b.createdAt.toISOString(),
            stallCount: 1,
          });
        }
        const globallyBlocked = Array.from(globalByKey.values()).slice(0, 50);

        return NextResponse.json({
          config: {
            stallTimeoutDays: timeoutDays,
            stallSwapMaxProgress,
            globalBlockThreshold,
            cutoffIso: cutoff.toISOString(),
          },
          scheduledJob: scheduledJob
            ? {
                id: scheduledJob.id,
                name: scheduledJob.name,
                schedule: scheduledJob.schedule,
                enabled: scheduledJob.enabled,
                lastRun: scheduledJob.lastRun?.toISOString() ?? null,
                lastRunJobId: scheduledJob.lastRunJobId ?? null,
              }
            : null,
          counts: {
            currentlyStalled: currentlyStalledCount,
            activeDownloadingTotal,
            recentSwapsShown: recentSwaps.length,
            globallyBlockedReleases: globalByKey.size,
          },
          globallyBlocked,
          currentlyStalled: currentlyStalled.map((r) => {
            const dh = r.downloadHistory[0];
            const startedAt = dh?.startedAt ?? null;
            const stalledDays = startedAt
              ? Math.floor((Date.now() - startedAt.getTime()) / (24 * 60 * 60 * 1000))
              : null;
            return {
              requestId: r.id,
              audiobook: r.audiobook,
              progress: r.progress,
              type: r.type,
              startedAt: startedAt?.toISOString() ?? null,
              stalledDays,
              torrentName: dh?.torrentName ?? null,
              indexerName: dh?.indexerName ?? null,
              downloadClient: dh?.downloadClient ?? null,
              downloadStatus: dh?.downloadStatus ?? null,
            };
          }),
          recentSwaps: recentSwaps.map((b) => ({
            id: b.id,
            requestId: b.requestId,
            request: b.request
              ? {
                  id: b.request.id,
                  status: b.request.status,
                  type: b.request.type,
                  audiobook: b.request.audiobook,
                }
              : null,
            releaseName: b.releaseName,
            indexerName: b.indexerName,
            reason: b.reason,
            createdAt: b.createdAt.toISOString(),
          })),
        });
      } catch (error) {
        logger.error('Failed to fetch stalled downloads', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: 'Failed to fetch stalled downloads' },
          { status: 500 }
        );
      }
    });
  });
}
