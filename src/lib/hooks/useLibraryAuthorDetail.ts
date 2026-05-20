/**
 * Component: Library Author Detail Hook
 * Documentation: documentation/frontend/components.md
 *
 * Fetches every owned book + series for one author via
 * GET /api/library/authors/[name]. Single SWR call — the underlying
 * endpoint already returns the full author detail in one trip, so we
 * don't need infinite pagination at the per-author level.
 */

'use client';

import useSWR from 'swr';
import { authenticatedFetcher } from '@/lib/utils/api';
import type { Audiobook } from './useAudiobooks';
import type { LibrarySeries } from './useLibrarySeries';

interface AuthorDetailResponse {
  success: boolean;
  author: string;
  bookCount: number;
  seriesCount: number;
  books: Audiobook[];
  series: LibrarySeries[];
}

export function useLibraryAuthorDetail(name: string | null) {
  const endpoint = name
    ? `/api/library/authors/${encodeURIComponent(name)}`
    : null;

  const { data, error, isLoading } = useSWR<AuthorDetailResponse>(
    endpoint,
    authenticatedFetcher,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );

  return {
    author: data?.author ?? name ?? '',
    books: data?.books ?? [],
    series: data?.series ?? [],
    bookCount: data?.bookCount ?? 0,
    seriesCount: data?.seriesCount ?? 0,
    isLoading,
    error,
  };
}
