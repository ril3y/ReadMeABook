/**
 * Component: Library Page Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockAuthState } from '../helpers/mock-auth';
import { resetMockRouter, routerMock, setMockSearchParams } from '../helpers/mock-next-navigation';

const useLibraryAudiobooksMock = vi.hoisted(() => vi.fn());
const useLibraryAuthorsMock     = vi.hoisted(() => vi.fn());
const useLibrarySeriesMock      = vi.hoisted(() => vi.fn());
const usePreferencesMock = vi.hoisted(() => ({
  cardSize: 5,
  setCardSize: vi.fn(),
  squareCovers: false,
  setSquareCovers: vi.fn(),
  hideAvailable: false,
  setHideAvailable: vi.fn(),
}));

vi.mock('@/lib/hooks/useLibraryAudiobooks', () => ({ useLibraryAudiobooks: useLibraryAudiobooksMock }));
vi.mock('@/lib/hooks/useLibraryAuthors',     () => ({ useLibraryAuthors:     useLibraryAuthorsMock }));
vi.mock('@/lib/hooks/useLibrarySeries',      () => ({ useLibrarySeries:      useLibrarySeriesMock }));

vi.mock('@/contexts/PreferencesContext', () => ({
  usePreferences: () => usePreferencesMock,
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock('@/components/audiobooks/AudiobookGrid', () => ({
  AudiobookGrid: ({ audiobooks, emptyMessage }: { audiobooks: any[]; emptyMessage: string }) => (
    <div data-testid="books-grid" data-count={audiobooks.length}>
      {audiobooks.length === 0 ? <span data-testid="books-empty">{emptyMessage}</span> : null}
    </div>
  ),
}));

vi.mock('@/components/ui/CardSizeControls', () => ({
  CardSizeControls: () => <div data-testid="card-size" />,
}));

vi.mock('@/components/ui/SquareCoversToggle', () => ({
  SquareCoversToggle: () => <div data-testid="square-toggle" />,
}));

function defaultBooks(overrides: Partial<any> = {}) {
  return {
    audiobooks: [],
    totalCount: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    error: null,
    ...overrides,
  };
}
function defaultAuthors(overrides: Partial<any> = {}) {
  return {
    authors: [],
    totalCount: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    error: null,
    ...overrides,
  };
}
function defaultSeries(overrides: Partial<any> = {}) {
  return {
    series: [],
    totalCount: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    error: null,
    ...overrides,
  };
}

describe('LibraryPage', () => {
  beforeEach(() => {
    resetMockAuthState();
    resetMockRouter();
    setMockSearchParams('');
    useLibraryAudiobooksMock.mockReset();
    useLibraryAuthorsMock.mockReset();
    useLibrarySeriesMock.mockReset();
    useLibraryAudiobooksMock.mockReturnValue(defaultBooks());
    useLibraryAuthorsMock.mockReturnValue(defaultAuthors());
    useLibrarySeriesMock.mockReturnValue(defaultSeries());
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the Books tab when no ?tab= is set', async () => {
    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);
    expect(screen.getByTestId('books-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('books-empty')).toBeInTheDocument();
  });

  it('honors ?tab=authors in the URL', async () => {
    setMockSearchParams('tab=authors');
    useLibraryAuthorsMock.mockReturnValue(defaultAuthors({
      authors: [{ name: 'Brandon Sanderson', bookCount: 14 }, { name: 'Andy Weir', bookCount: 3 }],
      totalCount: 2,
    }));

    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);

    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.getByText('Andy Weir')).toBeInTheDocument();
    expect(screen.getByText('14 books')).toBeInTheDocument();
    expect(screen.getByText('3 books')).toBeInTheDocument();
  });

  it('honors ?tab=series and renders series tiles with bookCount', async () => {
    setMockSearchParams('tab=series');
    useLibrarySeriesMock.mockReturnValue(defaultSeries({
      series: [
        { title: 'Joe Ledger', bookCount: 14, asin: 'SER1', coverArtUrl: undefined },
        { title: 'Mistborn',   bookCount: 3,  asin: null,   coverArtUrl: undefined },
      ],
      totalCount: 2,
    }));

    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);

    expect(screen.getByText('Joe Ledger')).toBeInTheDocument();
    expect(screen.getByText('Mistborn')).toBeInTheDocument();
    expect(screen.getByText('14 books')).toBeInTheDocument();
    expect(screen.getByText('3 books')).toBeInTheDocument();
  });

  it('switching tabs updates the URL via router.replace', async () => {
    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);

    // Click Authors tab
    fireEvent.click(screen.getByRole('button', { name: 'Authors' }));
    act(() => { vi.advanceTimersByTime(600); });
    expect(routerMock.replace).toHaveBeenCalledWith('/library?tab=authors', { scroll: false });

    // Click Series tab
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    act(() => { vi.advanceTimersByTime(600); });
    expect(routerMock.replace).toHaveBeenLastCalledWith('/library?tab=series', { scroll: false });
  });

  it('debounces the search input and includes both tab and q in the URL', async () => {
    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Authors' }));
    act(() => { vi.advanceTimersByTime(600); });

    const input = screen.getByPlaceholderText(/Filter authors/i);
    fireEvent.change(input, { target: { value: 'sand' } });
    // Before debounce fires, no extra replace yet
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.change(input, { target: { value: 'sander' } });
    act(() => { vi.advanceTimersByTime(600); });

    expect(routerMock.replace).toHaveBeenLastCalledWith(
      '/library?tab=authors&q=sander',
      { scroll: false }
    );
  });

  it('renders the series empty-state hint when there are no resolved series yet', async () => {
    setMockSearchParams('tab=series');
    useLibrarySeriesMock.mockReturnValue(defaultSeries({ series: [], totalCount: 0 }));
    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);
    expect(screen.getByText(/No series found in your library yet/i)).toBeInTheDocument();
    expect(screen.getByText(/depend on Audible metadata/i)).toBeInTheDocument();
  });

  it('shows the Load more button when books.hasMore is true and calls loadMore on click', async () => {
    const loadMore = vi.fn();
    useLibraryAudiobooksMock.mockReturnValue(defaultBooks({
      audiobooks: [{ asin: 'A1', title: 'T', author: 'A', isAvailable: true } as any],
      totalCount: 100,
      hasMore: true,
      loadMore,
    }));
    const { default: LibraryPage } = await import('@/app/library/page');
    render(<LibraryPage />);

    const btn = screen.getByRole('button', { name: /Load more/i });
    fireEvent.click(btn);
    expect(loadMore).toHaveBeenCalled();
  });
});
