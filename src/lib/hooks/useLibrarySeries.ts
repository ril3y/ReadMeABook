/**
 * Component: Library Series Fetching Hook
 * Documentation: documentation/frontend/components.md
 *
 * Single-shot fetch of distinct series in the owned library.
 * Returns the full list so the A-Z jump index is accurate immediately;
 * series counts are small (a few hundred at most for a personal library).
 *
 * Series field is sourced from plex_library directly (populated during
 * the scan-plex job from ABS metadata).
 */

'use client';

import useSWR from 'swr';
import { authenticatedFetcher } from '@/lib/utils/api';

export interface LibrarySeries {
  title: string;
  bookCount: number;
  asin: string | null;
  coverArtUrl?: string;
}

interface LibrarySeriesResponse {
  success: boolean;
  series: LibrarySeries[];
  totalCount: number;
}

export function useLibrarySeries(search: string = '', enabled: boolean = true) {
  const endpoint = enabled
    ? `/api/library/series${search ? `?search=${encodeURIComponent(search)}` : ''}`
    : null;

  // See useLibraryAuthors for the keepPreviousData rationale — tab
  // switching sets `enabled=false` and would otherwise drop the cached
  // list, producing a skeleton flash when the user comes back.
  const { data, error, isLoading } = useSWR<LibrarySeriesResponse>(
    endpoint,
    authenticatedFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      keepPreviousData: true,
    }
  );

  return {
    series: data?.series ?? [],
    totalCount: data?.totalCount ?? 0,
    isLoading,
    error,
  };
}
