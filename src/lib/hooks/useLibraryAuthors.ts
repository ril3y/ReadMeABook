/**
 * Component: Library Authors Fetching Hook
 * Documentation: documentation/frontend/components.md
 *
 * Single-shot fetch of distinct authors from the owned library.
 * Personal libraries top out at a few thousand authors so we return
 * them all in one response — required so the A-Z jump index is
 * accurate from the first paint (no "scroll to make Z clickable").
 */

'use client';

import useSWR from 'swr';
import { authenticatedFetcher } from '@/lib/utils/api';

export interface LibraryAuthor {
  name: string;
  bookCount: number;
}

interface LibraryAuthorsResponse {
  success: boolean;
  authors: LibraryAuthor[];
  totalCount: number;
}

export function useLibraryAuthors(search: string = '', enabled: boolean = true) {
  const endpoint = enabled
    ? `/api/library/authors${search ? `?search=${encodeURIComponent(search)}` : ''}`
    : null;

  const { data, error, isLoading } = useSWR<LibraryAuthorsResponse>(
    endpoint,
    authenticatedFetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
    }
  );

  return {
    authors: data?.authors ?? [],
    totalCount: data?.totalCount ?? 0,
    isLoading,
    error,
  };
}
