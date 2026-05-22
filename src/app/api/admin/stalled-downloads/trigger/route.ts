/**
 * Component: Admin Stalled Downloads Manual Trigger API
 * Documentation: documentation/admin-features/stalled-downloads.md
 *
 * Manually runs the detect-stalled-downloads processor immediately rather
 * than waiting for the hourly schedule. Uses the scheduled job ID so the
 * `lastRun` metadata is updated correctly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getSchedulerService } from '@/lib/services/scheduler.service';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.StalledDownloads.Trigger');

export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const scheduledJob = await prisma.scheduledJob.findFirst({
          where: { type: 'detect_stalled_downloads' },
        });

        let bullJobId: string;
        if (scheduledJob) {
          // Go through the scheduler so lastRun + lastRunJobId are tracked.
          const schedulerService = getSchedulerService();
          bullJobId = await schedulerService.triggerJobNow(scheduledJob.id);
        } else {
          // Fallback: schedule entry hasn't been seeded yet (fresh install).
          // Just queue the job directly so the admin can still kick it off.
          const jobQueue = getJobQueueService();
          bullJobId = await jobQueue.addDetectStalledDownloadsJob();
        }

        logger.info('Detect-stalled-downloads triggered manually', { bullJobId });

        return NextResponse.json({ success: true, jobId: bullJobId });
      } catch (error) {
        logger.error('Failed to trigger stall detection', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to trigger stall detection',
          },
          { status: 500 }
        );
      }
    });
  });
}
