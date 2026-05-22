/**
 * Component: Backfill Series Catalog Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Walks `plex_library` for series that don't yet have a `series_catalog`
 * row and resolves each by looking up ONE of the owned books via Audnexus
 * (which returns `seriesPrimary.asin` for any book in a series). Then
 * scrapes the resolved series page to populate `series_catalog` with the
 * `totalBooks` denominator so the Library Series tab can render
 * "X / Y total".
 *
 * Why this exists: the user's library has ~1,747 distinct series, but
 * only ~7 have an Audnexus-enriched `audiobook` row that supplies the
 * series_asin. The remaining 1,740 came from a Readarr bulk-import that
 * populated `plex_library` directly, never going through Audnexus. The
 * Library Series tab therefore shows "X books" with no denominator for
 * most series, defeating the missing-book indicator UI.
 *
 * Cadence: daily at 03:00 UTC, default ENABLED, capped at 50 series per
 * run to avoid Audnexus / Audible rate-limit pressure. Drains the
 * 1,740-series backlog over ~35 days.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getAudibleService } from '../integrations/audible.service';
import { scrapeSeriesPage } from '../integrations/audible-series';
import { upsertSeriesCatalog } from '../services/series-catalog.service';

export interface BackfillSeriesCatalogPayload {
  jobId?: string;
  scheduledJobId?: string;
}

const DEFAULT_MAX_PER_RUN = 50;
const INTER_REQUEST_DELAY_MS = 500;

export async function processBackfillSeriesCatalog(
  payload: BackfillSeriesCatalogPayload
): Promise<any> {
  const { jobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'BackfillSeriesCatalog');

  try {
    logger.info('Scanning for series without catalog data');

    // Find series in plex_library where:
    //   (a) we have at least one book with an ASIN (so Audnexus lookup is possible)
    //   (b) the series is not already in series_catalog (looked up by title here
    //       because we don't know the seriesAsin yet for these series — that's
    //       what we're about to resolve)
    //
    // `groupBy` collapses to one row per series and we attach one representative
    // book ASIN. Cap at the per-run limit.
    const candidates = await prisma.$queryRawUnsafe<Array<{
      series: string;
      sample_asin: string;
    }>>(
      `
      SELECT pl.series AS series, MIN(pl.asin) AS sample_asin
      FROM plex_library pl
      WHERE pl.series IS NOT NULL
        AND pl.series <> ''
        AND pl.asin IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM series_catalog sc WHERE LOWER(sc.title) = LOWER(pl.series)
        )
      GROUP BY pl.series
      ORDER BY pl.series
      LIMIT ${DEFAULT_MAX_PER_RUN}
      `
    );

    if (candidates.length === 0) {
      logger.info('No uncached series with book ASINs — nothing to backfill');
      return {
        success: true,
        message: 'No series need backfilling',
        seriesProcessed: 0,
        resolved: 0,
        unresolved: 0,
        cached: 0,
      };
    }

    logger.info(`Found ${candidates.length} series to resolve (capped at ${DEFAULT_MAX_PER_RUN}/run)`);

    const audibleService = getAudibleService();
    let resolved = 0;
    let unresolved = 0;
    let cached = 0;

    for (const candidate of candidates) {
      try {
        // Step 1: Audnexus book lookup. Returns the book's seriesPrimary.asin
        // when the book is part of a series. ~80ms / call typically.
        const book = await audibleService.getAudiobookDetails(candidate.sample_asin);
        if (!book) {
          unresolved++;
          logger.info(`Audnexus returned no data for ${candidate.sample_asin}`, {
            series: candidate.series,
          });
          continue;
        }

        if (!book.seriesAsin) {
          unresolved++;
          logger.info(`Book has no seriesAsin in Audnexus`, {
            series: candidate.series,
            bookAsin: candidate.sample_asin,
            bookTitle: book.title,
          });
          continue;
        }

        resolved++;

        // Step 2: Persist the audiobook row so future series-lookups (e.g.
        // /api/library/series enrichByName) can resolve this series → asin
        // without re-scraping. `audibleAsin` is nullable on Audiobook so it
        // lacks a unique constraint — use findFirst + update/create.
        const existing = await prisma.audiobook.findFirst({
          where: { audibleAsin: book.asin },
          select: { id: true },
        });
        if (existing) {
          await prisma.audiobook.update({
            where: { id: existing.id },
            data: {
              series: book.series ?? null,
              seriesPart: book.seriesPart ?? null,
              seriesAsin: book.seriesAsin,
            },
          });
        } else {
          await prisma.audiobook.create({
            data: {
              audibleAsin: book.asin,
              title: book.title,
              author: book.author,
              narrator: book.narrator ?? null,
              description: book.description ?? null,
              coverArtUrl: book.coverArtUrl ?? null,
              series: book.series ?? null,
              seriesPart: book.seriesPart ?? null,
              seriesAsin: book.seriesAsin,
            },
          });
        }

        // Step 3: Scrape the series page to get totalBooks. Audnexus exposes
        // per-book seriesPrimary but does NOT expose a "list books in series"
        // endpoint, so the scraper is the only way to get the denominator.
        const series = await scrapeSeriesPage(book.seriesAsin, 1);
        if (!series || series.bookCount === 0) {
          logger.info(`Resolved seriesAsin but scrape returned empty`, {
            series: candidate.series,
            seriesAsin: book.seriesAsin,
          });
          continue;
        }

        await upsertSeriesCatalog({
          seriesAsin: book.seriesAsin,
          title: series.title || book.series || candidate.series,
          totalBooks: series.bookCount,
          coverArtUrl: book.coverArtUrl ?? null,
          audibleUrl: `https://www.audible.com/series/${book.seriesAsin}`,
        });
        cached++;

        logger.info(`Cached series catalog`, {
          series: candidate.series,
          seriesAsin: book.seriesAsin,
          totalBooks: series.bookCount,
          ownedFromLibrary: candidate.sample_asin,
        });
      } catch (err) {
        unresolved++;
        logger.warn(`Backfill failed for series "${candidate.series}"`, {
          sampleAsin: candidate.sample_asin,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Inter-request delay to keep Audnexus + Audible happy. 500ms × 50 =
      // 25s/run — well below any rate-limit threshold.
      await new Promise(resolve => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
    }

    logger.info('Backfill pass complete', {
      seriesProcessed: candidates.length,
      resolved,
      unresolved,
      cached,
    });

    return {
      success: true,
      message: 'Backfill series catalog completed',
      seriesProcessed: candidates.length,
      resolved,
      unresolved,
      cached,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
