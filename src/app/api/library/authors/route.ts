/**
 * Component: Library Authors API Route
 * Documentation: documentation/frontend/components.md
 *
 * Distinct authors in the owned library (plex_library) with book counts.
 *
 * Returns the full list (no pagination) — personal libraries have <2k
 * authors and clients need the complete set to render the A-Z jump
 * index correctly from the first paint. The result is alphabetically
 * sorted; empty-string author values are filtered out.
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
    const search = (searchParams.get('search') || '').trim();

    const lib = await resolveLibraryId();
    if (!lib.ok) return lib.response;
    const libraryId = lib.libraryId;

    const where: Prisma.PlexLibraryWhereInput = {
      plexLibraryId: libraryId,
      author: { not: '' },
      ...(search ? { author: { contains: search, mode: 'insensitive' } } : {}),
    };

    const groups = await prisma.plexLibrary.groupBy({
      by: ['author'],
      where,
      _count: { _all: true },
    });

    const authors = groups
      .map(g => ({ name: g.author, bookCount: g._count._all }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      success: true,
      authors,
      totalCount: authors.length,
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
