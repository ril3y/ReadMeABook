/**
 * Component: Library Series Detail API Route
 * Documentation: documentation/frontend/components.md
 *
 * Returns every owned book for a single series (by display name, sourced
 * from plex_library.series), plus a best-effort resolution of the
 * Audible series ASIN + cached totalBooks.
 *
 * Why a separate page from /series/[asin]: most of the user's library
 * came from a Readarr bulk-import, so the majority of series names have
 * NO matching seriesAsin yet (the backfill-series-catalog processor is
 * gradually resolving them daily). Clicking those tiles previously fell
 * through to /search?q= which dropped the user on a generic search page
 * with no series context. This endpoint always returns the user's owned
 * books for the series regardless of whether we've resolved the ASIN,
 * and surfaces the ASIN + totalBooks when available so the page can
 * additionally show missing-book gaps.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Library.SeriesDetail');

async function getSeriesDetail(
  req: AuthenticatedRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name: nameParam } = await params;
    const series = decodeURIComponent(nameParam).trim();
    if (!series) {
      return NextResponse.json(
        { error: 'ValidationError', message: 'Series name is required' },
        { status: 400 }
      );
    }

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    // Step 1: fetch every owned book in this series, ordered by series_part
    // (numeric where possible) then title. Series part values can be strings
    // like "1.5", "Book 1", etc. — we order best-effort.
    const rows = await prisma.plexLibrary.findMany({
      where: { plexLibraryId: libraryId, series },
      select: {
        id: true,
        title: true,
        author: true,
        narrator: true,
        summary: true,
        duration: true,
        year: true,
        asin: true,
        plexGuid: true,
        thumbUrl: true,
        cachedLibraryCoverPath: true,
        seriesPart: true,
      },
      orderBy: [
        { seriesPart: 'asc' },
        { year: 'asc' },
        { title: 'asc' },
      ],
    });

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        series,
        bookCount: 0,
        books: [],
        seriesAsin: null,
        totalBooks: null,
        author: null,
      });
    }

    // Step 2: AudibleCache cover fallback (same pattern as author detail).
    const asinsNeedingCover = rows
      .filter(r => !r.cachedLibraryCoverPath && r.asin)
      .map(r => r.asin!) as string[];
    const cachedCovers = asinsNeedingCover.length > 0
      ? await prisma.audibleCache.findMany({
          where: { asin: { in: asinsNeedingCover } },
          select: { asin: true, coverArtUrl: true, cachedCoverPath: true },
        })
      : [];
    const coverByAsin = new Map<string, string>();
    for (const c of cachedCovers) {
      if (c.cachedCoverPath) {
        const filename = c.cachedCoverPath.split('/').pop();
        if (filename) coverByAsin.set(c.asin, `/api/cache/thumbnails/${filename}`);
      } else if (c.coverArtUrl) {
        coverByAsin.set(c.asin, c.coverArtUrl);
      }
    }

    const books = rows.map(r => {
      let coverArtUrl: string | undefined;
      if (r.cachedLibraryCoverPath) {
        const filename = r.cachedLibraryCoverPath.split('/').pop();
        if (filename) coverArtUrl = `/api/cache/library/${filename}`;
      } else if (r.asin && coverByAsin.has(r.asin)) {
        coverArtUrl = coverByAsin.get(r.asin);
      } else if (r.thumbUrl) {
        coverArtUrl = r.thumbUrl;
      }
      const durationMinutes = r.duration ? Math.round(Number(r.duration) / 1000 / 60) : undefined;
      return {
        asin: r.asin || `lib_${r.id}`,
        title: r.title,
        author: r.author,
        narrator: r.narrator || undefined,
        description: r.summary || undefined,
        coverArtUrl,
        durationMinutes,
        releaseDate: r.year ? `${r.year}-01-01` : undefined,
        seriesPart: r.seriesPart || undefined,
        isAvailable: true,
        dbId: r.id,
        plexGuid: r.plexGuid || null,
      };
    });

    // Step 3: best-effort seriesAsin resolution. Try the audiobook table
    // first (Audnexus-enriched). If we still don't have it, the
    // backfill-series-catalog processor will resolve it in a future pass.
    const ab = await prisma.audiobook.findFirst({
      where: { series, seriesAsin: { not: null } },
      select: { seriesAsin: true, coverArtUrl: true },
    });
    const seriesAsin = ab?.seriesAsin ?? null;

    // Step 4: catalog totalBooks if we have the asin AND the catalog is cached.
    let totalBooks: number | null = null;
    let seriesCoverArtUrl: string | null = ab?.coverArtUrl ?? null;
    if (seriesAsin) {
      const cat = await prisma.seriesCatalog.findUnique({
        where: { seriesAsin },
        select: { totalBooks: true, coverArtUrl: true },
      });
      if (cat) {
        totalBooks = cat.totalBooks;
        seriesCoverArtUrl = cat.coverArtUrl ?? seriesCoverArtUrl;
      }
    }

    // Step 5: pick a primary author (the most common one across owned books).
    const authorCounts = new Map<string, number>();
    for (const b of books) authorCounts.set(b.author, (authorCounts.get(b.author) ?? 0) + 1);
    const primaryAuthor = Array.from(authorCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return NextResponse.json({
      success: true,
      series,
      bookCount: books.length,
      books,
      seriesAsin,
      totalBooks,
      coverArtUrl: seriesCoverArtUrl,
      author: primaryAuthor,
    });
  } catch (error) {
    logger.error('Failed to fetch library series detail', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'FetchError', message: 'Failed to fetch series detail' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> }
) {
  return requireAuth(request, (req) => getSeriesDetail(req, context));
}
