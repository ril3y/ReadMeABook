/**
 * Component: Library Audiobooks Fetching Hook
 * Documentation: documentation/frontend/components.md
 *
 * Paginated fetch of owned-library audiobooks from /api/library/audiobooks.
 * Mirrors the useSearch pattern in useAudiobooks.ts (SWRInfinite).
 */

'use client';

import { useRef, useEffect, useCallback } from 'react';
import useSWRInfinite from 'swr/infinite';
import { authenticatedFetcher } from '@/lib/utils/api';
import type { Audiobook } from './useAudiobooks';

const PAGE_SIZE = 24;

interface LibraryAudiobooksPage {
  success: boolean;
  audiobooks: Audiobook[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

function dedupeByAsin<T extends { asin: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.asin)) return false;
    seen.add(item.asin);
    return true;
  });
}

export function useLibraryAudiobooks(search: string = '', sort: string = 'addedAt_desc') {
  const prevKeyRef = useRef(`${search}|${sort}`);

  const { data, error, size, setSize, isLoading, isValidating } = useSWRInfinite<LibraryAudiobooksPage>(
    (pageIndex, prevPageData) => {
      if (prevPageData && !prevPageData.hasMore) return null;
      const qs = new URLSearchParams({
        page: String(pageIndex + 1),
        pageSize: String(PAGE_SIZE),
        sort,
      });
      if (search) qs.set('search', search);
      return `/api/library/audiobooks?${qs.toString()}`;
    },
    authenticatedFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      revalidateFirstPage: false,
    }
  );

  // Reset to first page when search/sort changes
  useEffect(() => {
    const key = `${search}|${sort}`;
    if (key !== prevKeyRef.current) {
      prevKeyRef.current = key;
      setSize(1);
    }
  }, [search, sort, setSize]);

  const audiobooks = data
    ? dedupeByAsin(data.flatMap(page => page?.audiobooks || []))
    : [];
  const totalCount = data?.[0]?.totalCount || 0;
  const hasMore = !!(data && data.length > 0 && data[data.length - 1]?.hasMore);
  const isLoadingInitial = !data && !error;
  const isLoadingMore = !!(data && typeof data[size - 1] === 'undefined' && isValidating);

  const loadMore = useCallback(() => {
    setSize(prev => prev + 1);
  }, [setSize]);

  return {
    audiobooks,
    totalCount,
    hasMore,
    isLoading: isLoadingInitial,
    isLoadingMore,
    loadMore,
    error,
  };
}
