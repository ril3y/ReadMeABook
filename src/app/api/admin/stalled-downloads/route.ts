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
const DEFAULT_TIMEOUT_DAYS = 7;
const STALL_REASON_PREFIX = 'Stalled timeout';

function parseTimeoutDays(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_DAYS;
  return Math.min(Math.max(n, 1), 365);
}

export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const configService = getConfigService();
        const timeoutDays = parseTimeoutDays(await configService.get(CONFIG_KEY_TIMEOUT));
        const cutoff = new Date(Date.now() - timeoutDays * 24 * 60 * 60 * 1000);

        // Scheduled job metadata (last/next run, enabled flag).
        const scheduledJob = await prisma.scheduledJob.findFirst({
          where: { type: 'detect_stalled_downloads' },
        });

        // Currently stalled: same predicate as the processor itself.
        // Limited to first 100 for the dashboard list; full count comes from
        // a parallel count query so the UI can show "showing 100 of 247".
        const [currentlyStalled, currentlyStalledCount] = await Promise.all([
          prisma.request.findMany({
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
              progress: { lt: 100 },
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

        return NextResponse.json({
          config: {
            stallTimeoutDays: timeoutDays,
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
          },
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
