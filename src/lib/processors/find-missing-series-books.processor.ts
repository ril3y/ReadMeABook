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
    // Two modes:
    //
    //   Scheduled mode (no targetSeriesAsin): walks every watched_series row
    //   whose cooldown has elapsed, processes up to 25/run.
    //
    //   Single-series mode (targetSeriesAsin set, from the "Fill gaps"
    //   button API): processes ONE series directly. Does NOT require a
    //   watched_series row to exist — the button is the user's signal that
    //   they want this series filled, watched or not. Builds a synthetic
    //   "row" so the rest of the loop is uniform.
    const cooldownAgo = new Date(Date.now() - COOLDOWN_MS);
    type WatchedSeriesLike = {
      id: string | null;
      userId: string;
      seriesAsin: string;
      seriesTitle: string;
    };

    let watchedSeries: WatchedSeriesLike[];
    if (targetSeriesAsin) {
      if (!forcedUserId) {
        logger.warn('Single-series mode requires a userId payload (manual button)');
        return {
          success: false,
          message: 'Missing userId for single-series mode',
          seriesChecked: 0,
          requestsCreated: 0,
          skipped: 0,
        };
      }
      // Try to find an existing row so we can stamp lastCheckedAt; if none,
      // fall through with a synthetic record (no row update at the end).
      const existing = await prisma.watchedSeries.findFirst({
        where: { seriesAsin: targetSeriesAsin, userId: forcedUserId },
      });
      watchedSeries = [
        existing
          ? {
              id: existing.id,
              userId: existing.userId,
              seriesAsin: existing.seriesAsin,
              seriesTitle: existing.seriesTitle,
            }
          : {
              id: null,
              userId: forcedUserId,
              seriesAsin: targetSeriesAsin,
              seriesTitle: '(not watched yet)',
            },
      ];
      logger.info(
        existing
          ? `Single-series mode: processing watched series ${targetSeriesAsin}`
          : `Single-series mode: processing unwatched series ${targetSeriesAsin} (manual fill-gaps)`
      );
    } else {
      const rows = await prisma.watchedSeries.findMany({
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
        // Outer cap so we don't scrape hundreds of Audible pages in one pass.
        take: 25,
      });
      watchedSeries = rows.map(r => ({
        id: r.id,
        userId: r.userId,
        seriesAsin: r.seriesAsin,
        seriesTitle: r.seriesTitle,
      }));
    }

    if (watchedSeries.length === 0) {
      logger.info('No watched series due for refresh (all within 1-day cooldown)');
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
        // Scrape ALL pages of the Audible series catalog. Earlier version
        // only fetched page 1 (~8 books per page) which silently dropped
        // 50-90% of the catalog for long series (e.g. 19-book Lincoln Lawyer
        // — only 8 visible per page). Cap at 10 pages (~80 books) which
        // covers virtually every real series + bounds the scrape cost.
        const MAX_PAGES = 10;
        const catalogBooks: Array<{ asin?: string; title?: string; author?: string; narrator?: string; description?: string; coverArtUrl?: string; seriesPart?: string }> = [];
        let seriesTitleFromScrape: string | null = null;
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PAGES) {
          const detail = await scrapeSeriesPage(ws.seriesAsin, page);
          if (!detail || !detail.books || detail.books.length === 0) {
            if (page === 1) {
              logger.warn(`No catalog returned for series ${ws.seriesAsin} ("${ws.seriesTitle}")`);
              scrapeFailures++;
            }
            break;
          }
          if (page === 1) seriesTitleFromScrape = detail.title;
          catalogBooks.push(...detail.books);
          hasMore = detail.hasMore === true;
          page++;
        }

        if (catalogBooks.length === 0) {
          continue;
        }

        seriesProcessed++;
        const catalogAsins = catalogBooks.map(b => b.asin).filter((a): a is string => !!a);

        // Which of these are already owned (in ABS library cache)?
        const ownedRows = await prisma.plexLibrary.findMany({
          where: { asin: { in: catalogAsins } },
          select: { asin: true },
        });
        const ownedSet = new Set(ownedRows.map(r => r.asin).filter((a): a is string => !!a));
        const missingBooks = catalogBooks.filter(b => b.asin && !ownedSet.has(b.asin));

        logger.info(`Series "${ws.seriesTitle}": ${catalogBooks.length} catalog (${page - 1} pages scraped), ${ownedSet.size} owned, ${missingBooks.length} missing`);
        // (seriesTitleFromScrape is captured for future use — surfacing it
        // in result.message would let admins see "Resolved series title:
        // 'Foo'" but isn't required for correctness.)
        void seriesTitleFromScrape;

        if (missingBooks.length === 0) {
          // Stamp lastCheckedAt anyway so the cooldown advances.
          if (ws.id) {
            await prisma.watchedSeries.update({
              where: { id: ws.id },
              data: { lastCheckedAt: new Date() },
            });
          }
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
            // Bump skip reasons to info-level so we can debug why a book
            // didn't get a request (already-owned-by-title, duplicate
            // request, ignored, etc.). The createRequestForUser layer
            // already short-circuits the most common cases — surfacing
            // them here makes the no-op visible to admins.
            logger.info(`Skipped book (${result.reason}): ${result.message}`, {
              asin: book.asin,
              title: book.title,
              series: ws.seriesTitle,
            });
          }

          // Small spread so we don't burst-write to the DB.
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        if (ws.id) {
          await prisma.watchedSeries.update({
            where: { id: ws.id },
            data: { lastCheckedAt: new Date() },
          });
        }
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
