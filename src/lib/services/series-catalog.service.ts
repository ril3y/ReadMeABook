/**
 * Component: Series Catalog Service
 * Documentation: documentation/features/series-totals.md
 *
 * Lazy cache for "total books in a series" data sourced from Audible
 * (via audible-series.ts scraping). Used by the library Series tab to
 * show "X owned / Y total" without rescraping per render.
 *
 * Strategy:
 *   1. /api/series/{asin} already scrapes the series page — it calls
 *      `upsertSeriesCatalog` on every hit to keep entries fresh.
 *   2. /api/library/series reads from this cache and (best-effort)
 *      fires background refreshes for series that are missing or stale.
 *      Lookups are batched in one query; the route never awaits the
 *      refreshes — they populate the cache for the *next* page load.
 *
 * Why not Audnexus? The public Audnexus API exposes per-book metadata
 * (and "seriesPrimary" on a book), but does NOT expose a "list of books
 * in a series" endpoint. The existing audible-series scraper already
 * gives us bookCount, so we reuse it.
 */

import { prisma } from '@/lib/db';
import { scrapeSeriesPage } from '@/lib/integrations/audible-series';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('Service.SeriesCatalog');

// A series catalog entry is considered "fresh" for this long. Audible
// series rarely add books faster than this, and the worst case is just
// a slightly stale denominator on the library tile.
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SeriesCatalogLookupInput {
  seriesAsin: string;
  title?: string; // hint used only as a fallback when scraping yields nothing
}

export interface SeriesCatalogEntry {
  seriesAsin: string;
  title: string;
  totalBooks: number;
  coverArtUrl: string | null;
  audibleUrl: string | null;
  lastSyncedAt: Date;
}

/**
 * Upsert a catalog entry from a freshly-scraped series page.
 * Called from /api/series/{asin} on every successful scrape so cache
 * entries stay in sync without a dedicated job.
 *
 * Best-effort: errors are logged and swallowed so a DB hiccup never
 * breaks the request flow.
 */
export async function upsertSeriesCatalog(input: {
  seriesAsin: string;
  title: string;
  totalBooks: number;
  coverArtUrl?: string | null;
  audibleUrl?: string | null;
}): Promise<void> {
  if (!input.seriesAsin || !/^[A-Z0-9]{10}$/.test(input.seriesAsin)) return;
  if (!input.title || input.totalBooks <= 0) return;

  try {
    await prisma.seriesCatalog.upsert({
      where: { seriesAsin: input.seriesAsin },
      create: {
        seriesAsin: input.seriesAsin,
        title: input.title,
        totalBooks: input.totalBooks,
        coverArtUrl: input.coverArtUrl ?? null,
        audibleUrl: input.audibleUrl ?? null,
      },
      update: {
        title: input.title,
        totalBooks: input.totalBooks,
        coverArtUrl: input.coverArtUrl ?? null,
        audibleUrl: input.audibleUrl ?? null,
        lastSyncedAt: new Date(),
      },
    });
  } catch (error) {
    logger.warn('Failed to upsert series catalog entry', {
      seriesAsin: input.seriesAsin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Look up many series catalog entries in one query. Returns a map keyed
 * by lowercased ASIN — callers normally have ASINs in mixed case from
 * different sources, and uppercase-only matching tends to silently miss.
 */
export async function getSeriesCatalogByAsins(
  seriesAsins: string[]
): Promise<Map<string, SeriesCatalogEntry>> {
  const out = new Map<string, SeriesCatalogEntry>();
  const cleaned = Array.from(
    new Set(
      seriesAsins
        .filter((a): a is string => !!a && /^[A-Z0-9]{10}$/i.test(a))
        .map((a) => a.toUpperCase())
    )
  );
  if (cleaned.length === 0) return out;

  try {
    const rows = await prisma.seriesCatalog.findMany({
      where: { seriesAsin: { in: cleaned } },
    });
    for (const row of rows) {
      out.set(row.seriesAsin.toLowerCase(), {
        seriesAsin: row.seriesAsin,
        title: row.title,
        totalBooks: row.totalBooks,
        coverArtUrl: row.coverArtUrl,
        audibleUrl: row.audibleUrl,
        lastSyncedAt: row.lastSyncedAt,
      });
    }
  } catch (error) {
    logger.warn('Failed to look up series catalog entries', {
      count: cleaned.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return out;
}

/**
 * Returns the subset of input ASINs that are either missing from the
 * catalog or older than the freshness window. Caller can hand these
 * straight to {@link refreshSeriesCatalogInBackground}.
 */
export function pickStaleAsins(
  inputs: SeriesCatalogLookupInput[],
  catalog: Map<string, SeriesCatalogEntry>,
  now: Date = new Date()
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const i of inputs) {
    if (!i.seriesAsin) continue;
    const key = i.seriesAsin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = catalog.get(key);
    if (!entry) {
      out.push(i.seriesAsin);
      continue;
    }
    if (now.getTime() - entry.lastSyncedAt.getTime() > FRESHNESS_WINDOW_MS) {
      out.push(i.seriesAsin);
    }
  }
  return out;
}

/**
 * Kick off a fire-and-forget background refresh for the given ASINs.
 * Scrapes them in sequence with a short delay so we don't hammer Audible
 * if a large library has many stale series at once. Never throws — the
 * caller (typically the library route) returns its response immediately
 * and the next request reads the freshly populated cache.
 */
export function refreshSeriesCatalogInBackground(asins: string[]): void {
  if (asins.length === 0) return;
  // Cap concurrency: bounded sequential scrape with a small inter-request
  // delay so we don't burst Audible. The list is also capped overall so
  // a brand-new library with hundreds of unknown series doesn't trigger
  // a sustained scrape storm — the rest backfill across subsequent loads.
  const SCRAPE_CAP = 5;
  const BACKOFF_MS = 750;
  const targets = asins.slice(0, SCRAPE_CAP);

  void (async () => {
    for (const asin of targets) {
      try {
        const detail = await scrapeSeriesPage(asin, 1);
        if (!detail) {
          logger.debug('Background refresh: scrape returned null', { asin });
          continue;
        }
        await upsertSeriesCatalog({
          seriesAsin: detail.asin,
          title: detail.title,
          totalBooks: detail.bookCount,
          coverArtUrl: detail.books[0]?.coverArtUrl ?? null,
          audibleUrl: detail.audibleUrl,
        });
        logger.debug('Background refresh: upserted', {
          asin: detail.asin,
          totalBooks: detail.bookCount,
        });
      } catch (error) {
        logger.warn('Background refresh failed', {
          asin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  })();
}

export const __SERIES_CATALOG_INTERNALS__ = { FRESHNESS_WINDOW_MS };
