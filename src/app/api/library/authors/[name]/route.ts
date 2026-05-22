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

    // Step 3: aggregate series for this author directly from plex_library —
    // the same source of truth used by the series list endpoint. This avoids
    // the prior JOIN through `audiobook` that undercounted any book never
    // requested through RMAB (only requested books have an Audiobook row).
    const seriesGroups = await prisma.plexLibrary.groupBy({
      by: ['series'],
      where: { plexLibraryId: libraryId, author, series: { not: null } },
      _count: { _all: true },
    });
    const seriesNames = seriesGroups
      .map(g => g.series)
      .filter((s): s is string => !!s && s.trim().length > 0);

    // Best-effort enrichment: pull seriesAsin + coverArtUrl from `audiobook`
    // (the request-side cache) so series tiles can deep-link to /series/[asin]
    // when a row exists. Missing rows just fall back to a name-only tile.
    // Per-author series count caps at low double digits so one round-trip
    // is fine; the lookup key is lowercased so case drift between scans
    // doesn't lose the enrichment match.
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

    const series = seriesGroups
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
      })
      .sort((a, b) => a.title.localeCompare(b.title));

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
