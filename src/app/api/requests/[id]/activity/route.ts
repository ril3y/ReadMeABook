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
      const limitRaw = parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
      const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw));

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

      // Resolve cursor: we paginate by createdAt < cursorEvent.createdAt.
      let cursorCreatedAt: Date | undefined;
      if (cursor) {
        const cursorEvent = await prisma.jobEvent.findUnique({
          where: { id: cursor },
          select: { createdAt: true },
        });
        if (cursorEvent) cursorCreatedAt = cursorEvent.createdAt;
      }

      const rows = await prisma.jobEvent.findMany({
        where: {
          job: { requestId: id },
          ...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
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
        orderBy: { createdAt: 'desc' },
        take: limit + 1, // +1 to detect "has next page"
      });

      const hasMore = rows.length > limit;
      const eventsSlice = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? eventsSlice[eventsSlice.length - 1].id : null;

      const events = eventsSlice.map(e => ({
        id: e.id,
        timestamp: e.createdAt.toISOString(),
        level: e.level,
        context: e.context,
        message: e.message,
        metadata: e.metadata,
        jobId: e.job.id,
        jobType: e.job.type,
        jobStatus: e.job.status,
      }));

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
