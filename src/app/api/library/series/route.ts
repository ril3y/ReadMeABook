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
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';
import type { Prisma } from '@/generated/prisma';

const logger = RMABLogger.create('API.Library.Series');

interface SeriesAggregate {
  title: string;
  bookCount: number;
  asin: string | null;          // series ASIN (from audiobooks lookup) if known
  coverArtUrl?: string;
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
