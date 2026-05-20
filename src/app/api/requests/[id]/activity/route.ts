/**
 * Component: Request Activity API Route
 * Documentation: documentation/backend/api.md
 *
 * Returns the lifecycle event timeline for a single Request: every
 * JobEvent for every Job linked to this Request (via Job.requestId).
 *
 * Authorization mirrors GET /api/requests/[id]: request owner or admin.
 * Cursor-based pagination over JobEvent.createdAt — newest first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.RequestActivity');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const METADATA_MAX_CHARS = 4096;

/**
 * Strip extremely large metadata payloads server-side so a stray indexer
 * dump can't jank the timeline UI. The full blob is still available via
 * /admin/logs for admins; UI users only ever needed a summary anyway.
 */
function clampMetadata(meta: unknown): { value: unknown; truncated: boolean } {
  if (meta === null || meta === undefined) return { value: null, truncated: false };
  let serialized: string;
  try { serialized = JSON.stringify(meta); }
  catch { return { value: { _error: 'metadata_unserializable' }, truncated: true }; }
  if (serialized.length <= METADATA_MAX_CHARS) return { value: meta, truncated: false };
  return {
    value: { _truncated: true, preview: serialized.slice(0, METADATA_MAX_CHARS) },
    truncated: true,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'User not authenticated' },
          { status: 401 }
        );
      }

      const { id } = await params;
      const { searchParams } = new URL(req.url);
      const cursor = searchParams.get('cursor') || undefined;
      const limitParsed = Number.parseInt(searchParams.get('limit') ?? '', 10);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Number.isFinite(limitParsed) ? limitParsed : DEFAULT_LIMIT)
      );

      // Look up the request first to (a) confirm it exists and (b) authorize.
      const requestRecord = await prisma.request.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, userId: true, status: true },
      });
      if (!requestRecord) {
        return NextResponse.json(
          { error: 'NotFound', message: 'Request not found' },
          { status: 404 }
        );
      }
      if (requestRecord.userId !== req.user.id && req.user.role !== 'admin') {
        return NextResponse.json(
          { error: 'Forbidden', message: 'You do not have access to this request' },
          { status: 403 }
        );
      }

      // Resolve cursor — must belong to THIS request. Otherwise:
      //   - silent fallback would let a bad/missing cursor return page 1 forever
      //     (infinite "Load more" loop) and side-channel JobEvent existence cross-request.
      let cursorCreatedAt: Date | undefined;
      let cursorId: string | undefined;
      if (cursor) {
        const cursorEvent = await prisma.jobEvent.findFirst({
          where: { id: cursor, job: { requestId: id } },
          select: { id: true, createdAt: true },
        });
        if (!cursorEvent) {
          return NextResponse.json(
            { error: 'InvalidCursor', message: 'Cursor does not reference an event for this request' },
            { status: 400 }
          );
        }
        cursorCreatedAt = cursorEvent.createdAt;
        cursorId = cursorEvent.id;
      }

      // Compound ordering by (createdAt desc, id desc) prevents skip/duplicate
      // at page boundaries when multiple events share a ms-precision timestamp.
      const rows = await prisma.jobEvent.findMany({
        where: {
          job: { requestId: id },
          ...(cursorCreatedAt && cursorId
            ? {
                OR: [
                  { createdAt: { lt: cursorCreatedAt } },
                  { createdAt: cursorCreatedAt, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          level: true,
          context: true,
          message: true,
          metadata: true,
          createdAt: true,
          job: { select: { id: true, type: true, status: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, // +1 to detect "has next page"
      });

      const hasMore = rows.length > limit;
      const eventsSlice = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? eventsSlice[eventsSlice.length - 1].id : null;

      const events = eventsSlice.map(e => {
        const clamped = clampMetadata(e.metadata);
        return {
          id: e.id,
          timestamp: e.createdAt.toISOString(),
          level: e.level,
          context: e.context,
          message: e.message,
          metadata: clamped.value,
          metadataTruncated: clamped.truncated,
          jobId: e.job.id,
          jobType: e.job.type,
          jobStatus: e.job.status,
        };
      });

      return NextResponse.json({
        success: true,
        events,
        nextCursor,
        requestStatus: requestRecord.status,
      });
    } catch (error) {
      logger.error('Failed to fetch request activity', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'FetchError', message: 'Failed to fetch request activity' },
        { status: 500 }
      );
    }
  });
}
