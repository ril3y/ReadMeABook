/**
 * Component: Library Audiobooks API Route
 * Documentation: documentation/frontend/components.md
 *
 * Paginated browse of owned audiobooks from the plex_library table
 * (populated from Plex or Audiobookshelf depending on backendMode).
 *
 * Every row is by definition owned, so `isAvailable: true` is set on
 * the response so AudiobookCard renders its "In Library" badge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';
import type { Prisma } from '@/generated/prisma';

const logger = RMABLogger.create('API.Library.Audiobooks');

type Sort = 'addedAt_desc' | 'addedAt_asc' | 'title_asc' | 'title_desc' | 'author_asc';

function resolveOrderBy(sort: Sort): Prisma.PlexLibraryOrderByWithRelationInput {
  switch (sort) {
    case 'addedAt_asc':  return { addedAt: 'asc' };
    case 'title_asc':    return { title: 'asc' };
    case 'title_desc':   return { title: 'desc' };
    case 'author_asc':   return { author: 'asc' };
    case 'addedAt_desc':
    default:             return { addedAt: 'desc' };
  }
}

async function resolveLibraryId(): Promise<string | { error: NextResponse }> {
  const configService = getConfigService();
  const backendMode = await configService.getBackendMode();
  if (backendMode === 'audiobookshelf') {
    const absLibraryId = await configService.get('audiobookshelf.library_id');
    if (!absLibraryId) {
      return { error: NextResponse.json(
        { error: 'NoLibraryConfigured', message: 'No Audiobookshelf library ID configured' },
        { status: 400 }) };
    }
    return absLibraryId;
  }
  const plexConfig = await configService.getPlexConfig();
  if (!plexConfig.libraryId) {
    return { error: NextResponse.json(
      { error: 'NoLibraryConfigured', message: 'No Plex library ID configured' },
      { status: 400 }) };
  }
  return plexConfig.libraryId;
}

async function getLibraryAudiobooks(req: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSizeRaw = parseInt(searchParams.get('pageSize') || '24', 10) || 24;
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
    const search = (searchParams.get('search') || '').trim();
    const sort = (searchParams.get('sort') || 'addedAt_desc') as Sort;

    const libraryIdOrError = await resolveLibraryId();
    if (typeof libraryIdOrError !== 'string') return libraryIdOrError.error;
    const libraryId = libraryIdOrError;

    const where: Prisma.PlexLibraryWhereInput = {
      plexLibraryId: libraryId,
      ...(search ? {
        OR: [
          { title:  { contains: search, mode: 'insensitive' } },
          { author: { contains: search, mode: 'insensitive' } },
          { narrator: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };

    const [rows, totalCount] = await Promise.all([
      prisma.plexLibrary.findMany({
        where,
        select: {
          id: true,
          title: true,
          author: true,
          narrator: true,
          summary: true,
          duration: true,
          year: true,
          asin: true,
          isbn: true,
          plexGuid: true,
          thumbUrl: true,
          cachedLibraryCoverPath: true,
          addedAt: true,
        },
        orderBy: resolveOrderBy(sort),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.plexLibrary.count({ where }),
    ]);

    // AudibleCache cover fallback (only for rows without a library cache)
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

    const audiobooks = rows.map(r => {
      let coverArtUrl: string | undefined;
      if (r.cachedLibraryCoverPath) {
        const filename = r.cachedLibraryCoverPath.split('/').pop();
        if (filename) coverArtUrl = `/api/cache/library/${filename}`;
      } else if (r.asin && coverByAsin.has(r.asin)) {
        coverArtUrl = coverByAsin.get(r.asin);
      } else if (r.thumbUrl) {
        coverArtUrl = r.thumbUrl;
      }

      const durationMinutes = r.duration
        ? Math.round(Number(r.duration) / 1000 / 60)
        : undefined;

      return {
        // ASIN is required by AudiobookCard; fall back to a stable synthetic key
        // for library rows without an Audible ASIN.
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

    const totalPages = Math.ceil(totalCount / pageSize);
    return NextResponse.json({
      success: true,
      audiobooks,
      totalCount,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    logger.error('Failed to fetch library audiobooks', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'FetchError', message: 'Failed to fetch library audiobooks' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return requireAuth(req, getLibraryAudiobooks);
}
