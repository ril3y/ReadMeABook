/**
 * Component: Give Up Stuck Searches Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Marks requests as `failed` when they've been in `awaiting_search` for too
 * long AND already attempted enough search cycles to confirm the content
 * isn't available on any configured indexer.
 *
 * This is the terminal step in the lifecycle:
 *   awaiting_search → search → grab → download → available
 *                  │
 *                  └─→ (after N attempts over M days) → failed (auto-given-up)
 *
 * Why this exists: with the cursor-fix in retry-missing-torrents.processor.ts
 * we now rotate through the entire awaiting_search queue. Long-tail audiobook
 * content that isn't on ABB never finds a torrent. Without this processor
 * those requests would clog the queue forever, costing every retry-rotation
 * 100ms of DB time per skipped request.
 *
 * Defaults are CONSERVATIVE (10 attempts AND 60 days old) so this won't auto-
 * fail anything until the rotation has had time to accumulate evidence.
 * Admin can dial it down once they have confidence the rotation is working.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';

export interface GiveUpStuckSearchesPayload {
  jobId?: string;
  scheduledJobId?: string;
}

const DEFAULT_GIVE_UP_AFTER_DAYS = 60;
const DEFAULT_GIVE_UP_AFTER_ATTEMPTS = 10;
const DEFAULT_MAX_PER_RUN = 100;

const CONFIG_KEY_DAYS = 'automation.give_up_after_days';
const CONFIG_KEY_ATTEMPTS = 'automation.give_up_after_attempts';

function parseDays(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_GIVE_UP_AFTER_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GIVE_UP_AFTER_DAYS;
  return Math.min(Math.max(n, 1), 365);
}

function parseAttempts(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_GIVE_UP_AFTER_ATTEMPTS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GIVE_UP_AFTER_ATTEMPTS;
  return Math.min(Math.max(n, 1), 1000);
}

export async function processGiveUpStuckSearches(
  payload: GiveUpStuckSearchesPayload
): Promise<any> {
  const { jobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'GiveUpStuckSearches');

  try {
    const configService = getConfigService();
    const [daysRaw, attemptsRaw] = await Promise.all([
      configService.get(CONFIG_KEY_DAYS),
      configService.get(CONFIG_KEY_ATTEMPTS),
    ]);
    const days = parseDays(daysRaw);
    const minAttempts = parseAttempts(attemptsRaw);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    logger.info(`Scanning for stuck searches`, {
      criteria: `awaiting_search AND search_attempts >= ${minAttempts} AND last_search_at < ${cutoff.toISOString()}`,
    });

    // Find requests that have been searched N+ times over M+ days and still
    // didn't get a hit. Capped per run so a one-time backlog flip doesn't
    // bomb the notification system with thousands of "failed" events.
    const stuck = await prisma.request.findMany({
      where: {
        status: 'awaiting_search',
        deletedAt: null,
        searchAttempts: { gte: minAttempts },
        lastSearchAt: { lt: cutoff },
      },
      include: {
        audiobook: { select: { id: true, title: true, author: true } },
        user: { select: { plexUsername: true } },
      },
      orderBy: { lastSearchAt: 'asc' }, // oldest-stalled first
      take: DEFAULT_MAX_PER_RUN,
    });

    if (stuck.length === 0) {
      logger.info('No stuck searches qualify for give-up');
      return {
        success: true,
        message: 'No stuck searches to fail',
        giveUpAfterDays: days,
        giveUpAfterAttempts: minAttempts,
        givenUp: 0,
      };
    }

    logger.info(`Found ${stuck.length} requests to mark as failed (capped at ${DEFAULT_MAX_PER_RUN}/run)`);

    let givenUp = 0;
    let failed = 0;

    for (const request of stuck) {
      try {
        await prisma.request.update({
          where: { id: request.id },
          data: {
            status: 'failed',
            errorMessage: `Auto-failed: searched ${request.searchAttempts}× over ${days}+ days with no live torrents found. Manually revive from /admin if you want to retry.`,
            updatedAt: new Date(),
          },
        });
        givenUp++;
        logger.info(`Gave up on stuck request`, {
          requestId: request.id,
          title: request.audiobook.title,
          author: request.audiobook.author,
          searchAttempts: request.searchAttempts,
          lastSearchAt: request.lastSearchAt?.toISOString() ?? null,
        });
      } catch (err) {
        failed++;
        logger.error(`Failed to mark request as failed`, {
          requestId: request.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Spread DB ops to avoid pool exhaustion (same pattern as
      // retry-missing-torrents.processor.ts).
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(`Give-up pass complete`, {
      givenUp,
      failed,
      totalChecked: stuck.length,
      giveUpAfterDays: days,
      giveUpAfterAttempts: minAttempts,
    });

    return {
      success: true,
      message: 'Give-up stuck searches completed',
      giveUpAfterDays: days,
      giveUpAfterAttempts: minAttempts,
      totalChecked: stuck.length,
      givenUp,
      failed,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
