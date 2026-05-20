/**
 * Component: Library Series Fetching Hook
 * Documentation: documentation/frontend/components.md
 *
 * Paginated fetch of distinct series in the owned library.
 * Uses /api/library/series. Mirrors the useLibraryAudiobooks pattern.
 *
 * KNOWN LIMITATION: Only includes series for owned books that have a
 * matching Audiobook row (i.e., were requested or imported through RMAB
 * with Audible metadata). Books scanned directly into plex_library
 * without an Audiobook companion won't contribute. A future schema
 * change will close this gap by caching series on the library row.
 */

'use client';

import { useRef, useEffect, useCallback } from 'react';
import useSWRInfinite from 'swr/infinite';
import { authenticatedFetcher } from '@/lib/utils/api';

export interface LibrarySeries {
  title: string;
  bookCount: number;
  asin: string | null;
  coverArtUrl?: string;
}

interface LibrarySeriesPage {
  success: boolean;
  series: LibrarySeries[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

const PAGE_SIZE = 24;

function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

export function useLibrarySeries(search: string = '') {
  const prevKeyRef = useRef(search);

  const { data, error, size, setSize, isLoading, isValidating } = useSWRInfinite<LibrarySeriesPage>(
    (pageIndex, prevPageData) => {
      if (prevPageData && !prevPageData.hasMore) return null;
      const qs = new URLSearchParams({
        page: String(pageIndex + 1),
        pageSize: String(PAGE_SIZE),
      });
      if (search) qs.set('search', search);
      return `/api/library/series?${qs.toString()}`;
    },
    authenticatedFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      revalidateFirstPage: false,
    }
  );

  useEffect(() => {
    if (search !== prevKeyRef.current) {
      prevKeyRef.current = search;
      setSize(1);
    }
  }, [search, setSize]);

  const series = data
    ? dedupeByTitle(data.flatMap(page => page?.series || []))
    : [];
  const totalCount = data?.[0]?.totalCount || 0;
  const hasMore = !!(data && data.length > 0 && data[data.length - 1]?.hasMore);
  const isLoadingInitial = !data && !error;
  const isLoadingMore = !!(data && typeof data[size - 1] === 'undefined' && isValidating);

  const loadMore = useCallback(() => {
    setSize(prev => prev + 1);
  }, [setSize]);

  return {
    series,
    totalCount,
    hasMore,
    isLoading: isLoadingInitial,
    isLoadingMore,
    loadMore,
    error,
  };
}
