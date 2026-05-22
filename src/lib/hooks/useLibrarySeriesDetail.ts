/**
 * Component: Library Series Detail Hook
 * Documentation: documentation/frontend/components.md
 */

'use client';

import useSWR from 'swr';
import { authenticatedFetcher } from '@/lib/utils/api';
import type { Audiobook } from './useAudiobooks';

interface LibrarySeriesDetailResponse {
  success: boolean;
  series: string;
  bookCount: number;
  books: Audiobook[];
  seriesAsin: string | null;
  totalBooks: number | null;
  coverArtUrl: string | null;
  author: string | null;
}

export function useLibrarySeriesDetail(name: string | null) {
  const endpoint = name
    ? `/api/library/series/${encodeURIComponent(name)}`
    : null;

  const { data, error, isLoading } = useSWR<LibrarySeriesDetailResponse>(
    endpoint,
    authenticatedFetcher,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );

  return {
    series: data?.series ?? name ?? '',
    books: data?.books ?? [],
    bookCount: data?.bookCount ?? 0,
    seriesAsin: data?.seriesAsin ?? null,
    totalBooks: data?.totalBooks ?? null,
    coverArtUrl: data?.coverArtUrl ?? null,
    author: data?.author ?? null,
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
