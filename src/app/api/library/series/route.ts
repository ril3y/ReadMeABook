/**
 * Component: Library Series API Route
 * Documentation: documentation/frontend/components.md
 *
 * Distinct series in the owned library, with bookCount per series.
 *
 * Returns the full set (no pagination) — clients need the complete list
 * for the A-Z jump index. Personal libraries have at most a few hundred
 * series, so this is a single round-trip.
 *
 * Series field is read directly from plex_library (populated during the
 * scan-plex job from ABS metadata). No more JOIN to the audiobooks table,
 * which previously undercounted because only books that had been
 * *requested* through RMAB created an Audiobook row with series info.
 *
 * Each row may carry an optional `totalBooks` denominator sourced from
 * the series_catalog cache (populated by /api/series/{asin} on every
 * scrape, plus background refreshes for stale entries). When unknown,
 * the field is simply absent and the UI falls back to "X owned".
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';
import {
  getSeriesCatalogByAsins,
  pickStaleAsins,
  refreshSeriesCatalogInBackground,
} from '@/lib/services/series-catalog.service';
import type { Prisma } from '@/generated/prisma';

const logger = RMABLogger.create('API.Library.Series');

interface SeriesAggregate {
  title: string;
  bookCount: number;
  asin: string | null;          // series ASIN (from audiobooks lookup) if known
  coverArtUrl?: string;
  totalBooks?: number;          // From the series_catalog cache; absent when we don't yet know.
}

async function getLibrarySeries(req: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = (searchParams.get('search') || '').trim().toLowerCase();

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    // Aggregate by series directly from plex_library — fast, accurate.
    const where: Prisma.PlexLibraryWhereInput = {
      plexLibraryId: libraryId,
      series: { not: null },
    };
    const groups = await prisma.plexLibrary.groupBy({
      by: ['series'],
      where,
      _count: { _all: true },
    });

    const seriesNames = groups
      .map(g => g.series)
      .filter((s): s is string => !!s && s.trim().length > 0);

    // Optional enrichment: pick a representative seriesAsin + coverArtUrl
    // from any matching audiobooks row, so series tiles can deep-link to
    // /series/[asin] when available. This is a best-effort lookup — series
    // without any Audiobook row simply omit the ASIN and fall back to a
    // text search link in the UI. Distinct series names cap at a few
    // hundred per personal library, so one round-trip is fine.
    //
    // Lookup key is lowercased so case drift between scans (ABS title-cased
    // vs Audiobook entered through a different code path) doesn't lose the
    // enrichment match.
    type AbRow = { series: string | null; seriesAsin: string | null; coverArtUrl: string | null };
    const audiobookRows: AbRow[] = seriesNames.length === 0 ? [] : await prisma.audiobook.findMany({
      where: { series: { in: seriesNames }, seriesAsin: { not: null } },
      select: { series: true, seriesAsin: true, coverArtUrl: true },
    });
    const enrichByName = new Map<string, { asin: string; coverArtUrl: string | null }>();
    for (const r of audiobookRows) {
      if (!r.series || !r.seriesAsin) continue;
      const key = r.series.trim().toLowerCase();
      if (!enrichByName.has(key)) {
        enrichByName.set(key, { asin: r.seriesAsin, coverArtUrl: r.coverArtUrl });
      }
    }

    let all: SeriesAggregate[] = groups
      .filter(g => !!g.series && g.series.trim().length > 0)
      .map(g => {
        const key = g.series!.trim();
        const enriched = enrichByName.get(key.toLowerCase());
        return {
          title: key,
          bookCount: g._count._all,
          asin: enriched?.asin ?? null,
          coverArtUrl: enriched?.coverArtUrl ?? undefined,
        };
      });

    if (search) {
      all = all.filter(s => s.title.toLowerCase().includes(search));
    }
    all.sort((a, b) => a.title.localeCompare(b.title));

    // Series totals enrichment: look up `total_books` from the
    // series_catalog cache for any series tile that has an ASIN. Series
    // without an ASIN (no Audible mapping) just don't get a denominator.
    //
    // This is purely additive — if the cache lookup fails, we still
    // return the owned-count list. Missing/stale entries are refreshed
    // in the background so the *next* page render has them.
    const asinsWithSeries = all
      .map((s) => s.asin)
      .filter((a): a is string => !!a);
    if (asinsWithSeries.length > 0) {
      const catalog = await getSeriesCatalogByAsins(asinsWithSeries);
      for (const s of all) {
        if (!s.asin) continue;
        const entry = catalog.get(s.asin.toLowerCase());
        if (entry) s.totalBooks = entry.totalBooks;
      }
      const stale = pickStaleAsins(
        all.filter((s) => !!s.asin).map((s) => ({ seriesAsin: s.asin as string, title: s.title })),
        catalog
      );
      if (stale.length > 0) {
        // Fire-and-forget — bounded internally to avoid scrape storms.
        refreshSeriesCatalogInBackground(stale);
      }
    }

    return NextResponse.json({
      success: true,
      series: all,
      totalCount: all.length,
    });
  } catch (error) {
    logger.error('Failed to fetch library series', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'FetchError', message: 'Failed to fetch library series' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return requireAuth(req, getLibrarySeries);
}
