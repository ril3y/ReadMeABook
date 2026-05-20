/**
 * Component: Library Authors API Route
 * Documentation: documentation/frontend/components.md
 *
 * Distinct authors in the owned library (plex_library) with book counts.
 * Aggregated via Prisma groupBy. The PlexLibrary.author column is
 * non-nullable in the schema, but empty-string values can sneak in from
 * imperfect backend metadata — those are filtered out below.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { resolveLibraryId } from '@/lib/services/library-id';
import { RMABLogger } from '@/lib/utils/logger';
import type { Prisma } from '@/generated/prisma';

const logger = RMABLogger.create('API.Library.Authors');

async function getLibraryAuthors(req: AuthenticatedRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSizeRaw = parseInt(searchParams.get('pageSize') || '48', 10) || 48;
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
    const search = (searchParams.get('search') || '').trim();

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    const where: Prisma.PlexLibraryWhereInput = {
      plexLibraryId: libraryId,
      author: { not: '' },
      ...(search ? { author: { contains: search, mode: 'insensitive' } } : {}),
    };

    // Aggregate by author. Personal libraries typically have <2k distinct
    // authors so in-memory sort + paginate is fine — avoids the limitations
    // of groupBy combined with orderBy on group key in older Prisma.
    const groups = await prisma.plexLibrary.groupBy({
      by: ['author'],
      where,
      _count: { _all: true },
    });

    const allAuthors = groups
      .map(g => ({ name: g.author, bookCount: g._count._all }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totalCount = allAuthors.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const authors = allAuthors.slice((page - 1) * pageSize, page * pageSize);

    return NextResponse.json({
      success: true,
      authors,
      totalCount,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    logger.error('Failed to fetch library authors', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'FetchError', message: 'Failed to fetch library authors' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return requireAuth(req, getLibraryAuthors);
}
