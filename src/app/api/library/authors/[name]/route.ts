/**
 * Component: Library Author Detail API Route
 * Documentation: documentation/frontend/components.md
 *
 * Returns every owned book for a single author, plus the series this
 * author appears in (with bookCount per series). Used to populate the
 * /library/authors/[name] detail page.
 *
 * The author "name" path segment is the URL-encoded plain author string
 * from plex_library.author — that's the only stable handle we have
 * (PlexLibrary has no per-author ID and library authors don't carry an
 * Audible ASIN). Matching is case-sensitive against the stored value.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Library.AuthorDetail');

const ASIN_BATCH = 1000;

async function getAuthorDetail(
  req: AuthenticatedRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name: nameParam } = await params;
    const author = decodeURIComponent(nameParam).trim();
    if (!author) {
      return NextResponse.json(
        { error: 'ValidationError', message: 'Author name is required' },
        { status: 400 }
      );
    }

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    // Step 1: fetch every owned book for this author.
    const rows = await prisma.plexLibrary.findMany({
      where: { plexLibraryId: libraryId, author },
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
        addedAt: true,
      },
      orderBy: [{ year: 'asc' }, { title: 'asc' }],
    });

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        author,
        bookCount: 0,
        seriesCount: 0,
        books: [],
        series: [],
      });
    }

    // Step 2: AudibleCache cover fallback for rows missing a library cover.
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
        isAvailable: true,
        dbId: r.id,
        plexGuid: r.plexGuid || null,
      };
    });

    // Step 3: derive series for this author by joining Audiobook on ASIN.
    const ownedAsins = Array.from(new Set(
      rows.map(r => r.asin).filter((a): a is string => !!a)
    ));
    interface SeriesAgg { title: string; bookCount: number; asin: string | null; coverArtUrl?: string }
    const aggMap = new Map<string, SeriesAgg>();
    for (let i = 0; i < ownedAsins.length; i += ASIN_BATCH) {
      const batch = ownedAsins.slice(i, i + ASIN_BATCH);
      const audiobookRows = await prisma.audiobook.findMany({
        where: { audibleAsin: { in: batch }, series: { not: null } },
        select: { audibleAsin: true, series: true, seriesAsin: true, coverArtUrl: true },
      });
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
    }
    const series = Array.from(aggMap.values()).sort((a, b) => a.title.localeCompare(b.title));

    return NextResponse.json({
      success: true,
      author,
      bookCount: books.length,
      seriesCount: series.length,
      books,
      series,
    });
  } catch (error) {
    logger.error('Failed to fetch library author detail', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'FetchError', message: 'Failed to fetch author detail' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> }
) {
  return requireAuth(request, (req) => getAuthorDetail(req, context));
}
