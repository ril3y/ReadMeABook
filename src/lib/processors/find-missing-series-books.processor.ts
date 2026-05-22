/**
 * Component: Find Missing Series Books Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Walks every WATCHED series, fetches the full Audible catalog for that
 * series, compares against the user's owned books in plex_library, and
 * auto-creates Requests for the missing entries.
 *
 * Why this exists: prior to this processor the only way RMAB learned
 * "I'm missing book 7 of a 12-book series" was via the original Readarr
 * bulk-import or manual UI clicks. There was no cross-reference between
 * "what's in my ABS library" and "what does the full series catalog
 * contain". Users ended up with patchy series and no automated discovery.
 *
 * Safety design:
 *   - Default OFF in scheduler (admin must explicitly enable)
 *   - Only acts on series the user has explicitly watched (watched_series
 *     table) — implicit ownership is NOT a signal for auto-request, since
 *     someone might own 2 books of a 20-book series without wanting the rest
 *   - Per-watched-series cooldown via WatchedSeries.lastCheckedAt (1 day)
 *   - Per-run cap so a one-time enablement doesn't flood the queue
 *   - Reuses createRequestForUser for duplicate detection, ignore-list
 *     respect, library match, and search triggering
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { scrapeSeriesPage } from '../integrations/audible-series';
import { createRequestForUser } from '../services/request-creator.service';

export interface FindMissingSeriesBooksPayload {
  jobId?: string;
  scheduledJobId?: string;
  /** When set, process ONLY this series (skips watched-list iteration).
   *  Used by the per-series manual "Fill gaps" API endpoint. */
  seriesAsin?: string;
  /** When set, process for this user (overrides the watched-series owner). */
  userId?: string;
}

const DEFAULT_MAX_REQUESTS_PER_RUN = 100;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day per watched series

export async function processFindMissingSeriesBooks(
  payload: FindMissingSeriesBooksPayload
): Promise<any> {
  const { jobId, seriesAsin: targetSeriesAsin, userId: forcedUserId } = payload;
  const logger = RMABLogger.forJob(jobId, 'FindMissingSeriesBooks');

  try {
    // Single-series mode (manual API call) bypasses the cooldown and
    // watched-series gate. Scheduled mode walks all watched series whose
    // cooldown has elapsed.
    const cooldownAgo = new Date(Date.now() - COOLDOWN_MS);
    const watchedSeries = targetSeriesAsin
      ? await prisma.watchedSeries.findMany({
          where: forcedUserId
            ? { seriesAsin: targetSeriesAsin, userId: forcedUserId }
            : { seriesAsin: targetSeriesAsin },
          take: 1,
        })
      : await prisma.watchedSeries.findMany({
          where: {
            OR: [
              { lastCheckedAt: null },
              { lastCheckedAt: { lt: cooldownAgo } },
            ],
          },
          orderBy: [
            { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
            { createdAt: 'asc' },
          ],
          // The per-run cap below counts created REQUESTS, but each watched
          // series could yield many requests. We limit watched-series count
          // here as a coarse outer cap to avoid scraping hundreds of Audible
          // pages in one pass.
          take: 25,
        });

    if (watchedSeries.length === 0) {
      logger.info(
        targetSeriesAsin
          ? `No watched_series row for ${targetSeriesAsin}`
          : 'No watched series due for refresh (all within 1-day cooldown)'
      );
      return {
        success: true,
        message: 'No watched series to process',
        seriesChecked: 0,
        requestsCreated: 0,
        skipped: 0,
      };
    }

    logger.info(`Processing ${watchedSeries.length} watched series`);

    let requestsCreated = 0;
    let skipped = 0;
    let seriesProcessed = 0;
    let scrapeFailures = 0;

    for (const ws of watchedSeries) {
      if (requestsCreated >= DEFAULT_MAX_REQUESTS_PER_RUN) {
        logger.info(`Hit per-run request cap (${DEFAULT_MAX_REQUESTS_PER_RUN}), stopping`);
        break;
      }

      try {
        const seriesDetail = await scrapeSeriesPage(ws.seriesAsin, 1);
        if (!seriesDetail || !seriesDetail.books || seriesDetail.books.length === 0) {
          logger.warn(`No catalog returned for series ${ws.seriesAsin} ("${ws.seriesTitle}")`);
          scrapeFailures++;
          continue;
        }

        seriesProcessed++;
        const catalogAsins = seriesDetail.books.map(b => b.asin).filter(Boolean);

        // Which of these are already owned (in ABS library cache)?
        const ownedRows = await prisma.plexLibrary.findMany({
          where: { asin: { in: catalogAsins } },
          select: { asin: true },
        });
        const ownedSet = new Set(ownedRows.map(r => r.asin).filter((a): a is string => !!a));
        const missingBooks = seriesDetail.books.filter(b => b.asin && !ownedSet.has(b.asin));

        logger.info(`Series "${ws.seriesTitle}": ${seriesDetail.books.length} catalog, ${ownedSet.size} owned, ${missingBooks.length} missing`);

        if (missingBooks.length === 0) {
          // Stamp lastCheckedAt anyway so the cooldown advances.
          await prisma.watchedSeries.update({
            where: { id: ws.id },
            data: { lastCheckedAt: new Date() },
          });
          continue;
        }

        // Create requests for missing books. createRequestForUser handles
        // duplicate detection, library-match short-circuits, ignore-list
        // respect, and triggers the search job. It never throws — returns
        // { success: false, reason } for skips.
        const targetUserId = forcedUserId ?? ws.userId;
        for (const book of missingBooks) {
          if (requestsCreated >= DEFAULT_MAX_REQUESTS_PER_RUN) break;
          if (!book.asin || !book.title || !book.author) {
            skipped++;
            continue;
          }

          const result = await createRequestForUser(
            targetUserId,
            {
              asin: book.asin,
              title: book.title,
              author: book.author,
              narrator: book.narrator,
              description: book.description,
              coverArtUrl: book.coverArtUrl,
            },
            { skipAutoSearch: false, bypassIgnore: false }
          );

          if (result.success) {
            requestsCreated++;
            logger.info(`Requested missing book`, {
              asin: book.asin,
              title: book.title,
              series: ws.seriesTitle,
              seriesPart: book.seriesPart,
            });
          } else {
            skipped++;
            logger.debug(`Skipped book (${result.reason})`, {
              asin: book.asin,
              title: book.title,
            });
          }

          // Small spread so we don't burst-write to the DB.
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        await prisma.watchedSeries.update({
          where: { id: ws.id },
          data: { lastCheckedAt: new Date() },
        });
      } catch (err) {
        logger.error(`Failed processing series ${ws.seriesAsin}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        scrapeFailures++;
      }
    }

    logger.info('Find-missing-series-books pass complete', {
      seriesProcessed,
      requestsCreated,
      skipped,
      scrapeFailures,
    });

    return {
      success: true,
      message: 'Find missing series books completed',
      seriesChecked: seriesProcessed,
      requestsCreated,
      skipped,
      scrapeFailures,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
