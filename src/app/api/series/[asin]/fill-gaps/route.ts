/**
 * Component: Series Fill-Gaps API
 * Documentation: documentation/features/series-totals.md
 *
 * Manual on-demand counterpart to the scheduled `find_missing_series_books`
 * job. Queues a single-series run scoped to one ASIN. Caller's user ID is
 * used as the request owner (so requests belong to whoever clicked the
 * button, not whoever happens to have the series in their watched list).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Series.FillGaps');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      const { asin } = await params;
      if (!asin || !/^[A-Z0-9]{8,12}$/i.test(asin)) {
        return NextResponse.json({ error: 'Invalid series ASIN' }, { status: 400 });
      }

      const userId = req.user?.id;
      if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const jobQueue = getJobQueueService();
      const bullJobId = await jobQueue.addFindMissingSeriesBooksJob({
        seriesAsin: asin,
        userId,
      });

      logger.info('Series fill-gaps job queued', { asin, userId, bullJobId });

      return NextResponse.json({
        success: true,
        jobId: bullJobId,
        message: 'Gap-fill job queued. Missing books will be requested in a few seconds.',
      });
    } catch (error) {
      logger.error('Fill-gaps failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to queue fill-gaps',
        },
        { status: 500 }
      );
    }
  });
}
