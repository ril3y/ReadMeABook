/**
 * Component: Library Browse + Request Activity Hooks Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useSWRMock = vi.hoisted(() => vi.fn());
const useSWRInfiniteMock = vi.hoisted(() => vi.fn());
const authenticatedFetcherMock = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({ default: useSWRMock }));
vi.mock('swr/infinite', () => ({ default: useSWRInfiniteMock }));
vi.mock('@/lib/utils/api', () => ({ authenticatedFetcher: authenticatedFetcherMock }));

const HookProbe = ({ label, value }: { label: string; value: any }) => (
  <div data-testid={label}>{JSON.stringify(value)}</div>
);

beforeEach(() => {
  useSWRMock.mockReset();
  useSWRInfiniteMock.mockReset();
  authenticatedFetcherMock.mockReset();
  vi.resetModules();
});

describe('useLibraryAudiobooks', () => {
  it('builds the audiobooks endpoint URL with page+pageSize+sort and a search filter', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [
        { audiobooks: [{ asin: 'A1' }, { asin: 'A2' }], totalCount: 2, hasMore: false },
      ],
      error: null, size: 1, setSize: vi.fn(), isLoading: false, isValidating: false,
    });

    const { useLibraryAudiobooks } = await import('@/lib/hooks/useLibraryAudiobooks');

    const Probe = () => {
      const r = useLibraryAudiobooks('sander', 'title_asc');
      return <HookProbe label="lib-books" value={{ count: r.audiobooks.length, total: r.totalCount, hasMore: r.hasMore }} />;
    };
    render(<Probe />);

    // The key-generator should produce a URL containing the search + sort.
    const keyFn = useSWRInfiniteMock.mock.calls[0][0];
    const url = keyFn(0, null);
    expect(url).toContain('/api/library/audiobooks?');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=24');
    expect(url).toContain('sort=title_asc');
    expect(url).toContain('search=sander');

    const parsed = JSON.parse(screen.getByTestId('lib-books').textContent || '{}');
    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(2);
    expect(parsed.hasMore).toBe(false);
  });

  it('returns null URL after prevPage.hasMore=false to stop infinite fetch', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [], error: null, size: 1, setSize: vi.fn(), isLoading: false, isValidating: false,
    });
    const { useLibraryAudiobooks } = await import('@/lib/hooks/useLibraryAudiobooks');
    const Probe = () => {
      useLibraryAudiobooks('');
      return null;
    };
    render(<Probe />);
    const keyFn = useSWRInfiniteMock.mock.calls[0][0];
    expect(keyFn(1, { hasMore: false })).toBeNull();
  });

  it('dedupes results by ASIN across pages', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [
        { audiobooks: [{ asin: 'A1' }, { asin: 'A2' }], hasMore: true },
        { audiobooks: [{ asin: 'A2' }, { asin: 'A3' }], hasMore: false },
      ],
      error: null, size: 2, setSize: vi.fn(), isLoading: false, isValidating: false,
    });
    const { useLibraryAudiobooks } = await import('@/lib/hooks/useLibraryAudiobooks');
    const Probe = () => {
      const r = useLibraryAudiobooks('');
      return <HookProbe label="dedupe" value={r.audiobooks.map((a: any) => a.asin)} />;
    };
    render(<Probe />);
    const parsed = JSON.parse(screen.getByTestId('dedupe').textContent || '[]');
    expect(parsed).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('useLibraryAuthors', () => {
  it('builds the authors endpoint URL with paging+search', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [{ authors: [{ name: 'A', bookCount: 1 }], totalCount: 1, hasMore: false }],
      error: null, size: 1, setSize: vi.fn(), isLoading: false, isValidating: false,
    });
    const { useLibraryAuthors } = await import('@/lib/hooks/useLibraryAuthors');
    const Probe = () => { useLibraryAuthors('sander'); return null; };
    render(<Probe />);
    const keyFn = useSWRInfiniteMock.mock.calls[0][0];
    const url = keyFn(0, null);
    expect(url).toContain('/api/library/authors?');
    expect(url).toContain('pageSize=48');
    expect(url).toContain('search=sander');
  });

  it('dedupes results by author name', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [
        { authors: [{ name: 'A', bookCount: 2 }, { name: 'B', bookCount: 1 }], hasMore: true },
        { authors: [{ name: 'B', bookCount: 1 }, { name: 'C', bookCount: 3 }], hasMore: false },
      ],
      error: null, size: 2, setSize: vi.fn(), isLoading: false, isValidating: false,
    });
    const { useLibraryAuthors } = await import('@/lib/hooks/useLibraryAuthors');
    const Probe = () => {
      const r = useLibraryAuthors('');
      return <HookProbe label="auths" value={r.authors.map(a => a.name)} />;
    };
    render(<Probe />);
    expect(JSON.parse(screen.getByTestId('auths').textContent || '[]')).toEqual(['A', 'B', 'C']);
  });
});

describe('useLibrarySeries', () => {
  it('hits /api/library/series with pageSize=24', async () => {
    useSWRInfiniteMock.mockReturnValue({
      data: [{ series: [], totalCount: 0, hasMore: false }],
      error: null, size: 1, setSize: vi.fn(), isLoading: false, isValidating: false,
    });
    const { useLibrarySeries } = await import('@/lib/hooks/useLibrarySeries');
    const Probe = () => { useLibrarySeries(''); return null; };
    render(<Probe />);
    const keyFn = useSWRInfiniteMock.mock.calls[0][0];
    const url = keyFn(0, null);
    expect(url).toContain('/api/library/series?');
    expect(url).toContain('pageSize=24');
  });
});
