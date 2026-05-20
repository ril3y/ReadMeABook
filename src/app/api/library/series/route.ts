/**
 * Component: Library Series API Route
 * Documentation: documentation/frontend/components.md
 *
 * Distinct series in the owned library. Series data isn't carried in
 * plex_library directly — it lives on the Audiobook model (populated
 * during request creation from Audible search results). So we JOIN
 * plex_library.asin → audiobooks.audible_asin and aggregate by series.
 *
 * KNOWN LIMITATION: Only books that have a matching Audiobook row
 * (typically books that were requested or imported through RMAB)
 * contribute to series counts. Books scanned directly into plex_library
 * from a backend without an Audiobook companion record won't appear.
 * A follow-up PR will add a dedicated series cache populated during the
 * library scan to close this gap.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Library.Series');

// Chunk size for the IN-clause that joins owned ASINs against audiobooks.
// Postgres handles 5k params fine, but MySQL's default max_allowed_packet
// and Prisma's parameter limit can choke around very-large IN lists.
const ASIN_BATCH = 1000;

interface SeriesAggregate {
  title: string;
  bookCount: number;
  asin: string | null;          // series ASIN if known (links to /series/[asin])
  coverArtUrl?: string;
}

async function getLibrarySeries(req: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSizeRaw = parseInt(searchParams.get('pageSize') || '24', 10) || 24;
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
    const search = (searchParams.get('search') || '').trim().toLowerCase();

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    // Step 1: collect ASINs we own from plex_library
    const ownedRows = await prisma.plexLibrary.findMany({
      where: { plexLibraryId: libraryId, asin: { not: null } },
      select: { asin: true },
    });
    const ownedAsins = Array.from(new Set(
      ownedRows.map(r => r.asin).filter((a): a is string => !!a)
    ));

    if (ownedAsins.length === 0) {
      return NextResponse.json({
        success: true,
        series: [],
        totalCount: 0,
        page,
        pageSize,
        totalPages: 0,
        hasMore: false,
      });
    }

    // Step 2: find Audiobook rows with series data for those ASINs.
    // Chunk the IN list so we never push past DB parameter limits at 5k+ rows.
    type AudiobookRow = {
      audibleAsin: string | null;
      series: string | null;
      seriesAsin: string | null;
      coverArtUrl: string | null;
    };
    const audiobookRows: AudiobookRow[] = [];
    for (let i = 0; i < ownedAsins.length; i += ASIN_BATCH) {
      const batch = ownedAsins.slice(i, i + ASIN_BATCH);
      const rows = await prisma.audiobook.findMany({
        where: {
          audibleAsin: { in: batch },
          series: { not: null },
        },
        select: {
          audibleAsin: true,
          series: true,
          seriesAsin: true,
          coverArtUrl: true,
        },
      });
      audiobookRows.push(...rows);
    }

    // Step 3: aggregate by series name (case-insensitive)
    const aggMap = new Map<string, SeriesAggregate>();
    for (const a of audiobookRows) {
      if (!a.series) continue;
      const key = a.series.trim();
      if (!key) continue;
      const existing = aggMap.get(key);
      if (existing) {
        existing.bookCount += 1;
        if (!existing.asin && a.seriesAsin) existing.asin = a.seriesAsin;
        if (!existing.coverArtUrl && a.coverArtUrl) existing.coverArtUrl = a.coverArtUrl;
      } else {
        aggMap.set(key, {
          title: key,
          bookCount: 1,
          asin: a.seriesAsin || null,
          coverArtUrl: a.coverArtUrl || undefined,
        });
      }
    }

    let allSeries = Array.from(aggMap.values());
    if (search) {
      allSeries = allSeries.filter(s => s.title.toLowerCase().includes(search));
    }
    allSeries.sort((a, b) => a.title.localeCompare(b.title));

    const totalCount = allSeries.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const series = allSeries.slice((page - 1) * pageSize, page * pageSize);

    return NextResponse.json({
      success: true,
      series,
      totalCount,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
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
