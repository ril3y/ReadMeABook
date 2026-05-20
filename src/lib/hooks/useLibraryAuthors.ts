/**
 * Component: Library Authors Fetching Hook
 * Documentation: documentation/frontend/components.md
 *
 * Paginated fetch of distinct authors from the owned library.
 * Uses /api/library/authors. Mirrors the useLibraryAudiobooks pattern.
 */

'use client';

import { useRef, useEffect, useCallback } from 'react';
import useSWRInfinite from 'swr/infinite';
import { authenticatedFetcher } from '@/lib/utils/api';

export interface LibraryAuthor {
  name: string;
  bookCount: number;
}

interface LibraryAuthorsPage {
  success: boolean;
  authors: LibraryAuthor[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

const PAGE_SIZE = 48;

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export function useLibraryAuthors(search: string = '') {
  const prevKeyRef = useRef(search);

  const { data, error, size, setSize, isLoading, isValidating } = useSWRInfinite<LibraryAuthorsPage>(
    (pageIndex, prevPageData) => {
      if (prevPageData && !prevPageData.hasMore) return null;
      const qs = new URLSearchParams({
        page: String(pageIndex + 1),
        pageSize: String(PAGE_SIZE),
      });
      if (search) qs.set('search', search);
      return `/api/library/authors?${qs.toString()}`;
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

  const authors = data
    ? dedupeByName(data.flatMap(page => page?.authors || []))
    : [];
  const totalCount = data?.[0]?.totalCount || 0;
  const hasMore = !!(data && data.length > 0 && data[data.length - 1]?.hasMore);
  const isLoadingInitial = !data && !error;
  const isLoadingMore = !!(data && typeof data[size - 1] === 'undefined' && isValidating);

  const loadMore = useCallback(() => {
    setSize(prev => prev + 1);
  }, [setSize]);

  return {
    authors,
    totalCount,
    hasMore,
    isLoading: isLoadingInitial,
    isLoadingMore,
    loadMore,
    error,
  };
}
