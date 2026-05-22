/**
 * Component: Library Page
 * Documentation: documentation/frontend/components.md
 *
 * Browse the owned audiobook library by Books or Authors. Driven by the
 * existing plex_library table (works for both Plex and Audiobookshelf
 * backends). Search box filters within the active tab.
 */

'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { useLibraryAudiobooks } from '@/lib/hooks/useLibraryAudiobooks';
import { useLibraryAuthors, type LibraryAuthor } from '@/lib/hooks/useLibraryAuthors';
import { useLibrarySeries, type LibrarySeries } from '@/lib/hooks/useLibrarySeries';
import { useInfiniteScroll } from '@/lib/hooks/useInfiniteScroll';
import { AlphabetIndex, letterBucket } from '@/components/ui/AlphabetIndex';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { CardSizeControls } from '@/components/ui/CardSizeControls';
import { SquareCoversToggle } from '@/components/ui/SquareCoversToggle';
import { usePreferences } from '@/contexts/PreferencesContext';

type Tab = 'books' | 'authors' | 'series';

function LibraryAuthorTile({ author }: { author: LibraryAuthor }) {
  // Navigates to the library author detail page (owned books + series for
  // this author). Fallback to /search?q= is no longer needed since we have
  // a dedicated detail page now.
  const href = `/library/authors/${encodeURIComponent(author.name)}`;
  return (
    <Link
      href={href}
      data-letter={letterBucket(author.name)}
      className="group block p-4 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200/70 dark:border-gray-700/70 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-md transition-all"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400">
          {author.name}
        </h3>
        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200">
          {author.bookCount} {author.bookCount === 1 ? 'book' : 'books'}
        </span>
      </div>
    </Link>
  );
}

function LibrarySeriesTile({ series }: { series: LibrarySeries }) {
  // Always route to the Library Series Detail page (by display name). That
  // page ALWAYS works — lists the owned books from plex_library regardless
  // of whether we've resolved the seriesAsin yet. When the asin IS known
  // the page surfaces a "View full series catalog" deep-link to the
  // Audible /series/[asin] view. Previously this fell through to /search?q=
  // for asin-less series, dropping users on a generic search page.
  const href = `/library/series/${encodeURIComponent(series.title)}`;

  // Count badge: when we have a known catalog total, render "X / Y total"
  // and surface how many books the user is missing. When totalBooks is
  // unknown (no Audible mapping yet, or the cache hasn't backfilled), we
  // fall back to the existing "X book(s)" rendering rather than guessing.
  const hasTotal = typeof series.totalBooks === 'number' && series.totalBooks > 0;
  const missing = hasTotal ? Math.max(0, (series.totalBooks as number) - series.bookCount) : 0;
  const complete = hasTotal && missing === 0;
  const countLabel = hasTotal
    ? `${series.bookCount} / ${series.totalBooks} total`
    : `${series.bookCount} ${series.bookCount === 1 ? 'book' : 'books'}`;
  const countBadgeClasses = complete
    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200'
    : hasTotal
      ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200'
      : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200';

  return (
    <Link
      href={href}
      data-letter={letterBucket(series.title)}
      className="group block p-4 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200/70 dark:border-gray-700/70 hover:border-emerald-400 dark:hover:border-emerald-500 hover:shadow-md transition-all"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-emerald-600 dark:group-hover:text-emerald-400">
          {series.title}
        </h3>
        <div className="shrink-0 flex items-center gap-1.5">
          {hasTotal && missing > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200"
              title={`${missing} book${missing === 1 ? '' : 's'} not in your library`}
            >
              {missing} missing
            </span>
          )}
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${countBadgeClasses}`}
            title={hasTotal ? `${series.bookCount} owned of ${series.totalBooks} in the series` : undefined}
          >
            {countLabel}
          </span>
        </div>
      </div>
    </Link>
  );
}

function LibraryPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const tabParam = searchParams.get('tab');
  const initialTab: Tab =
    tabParam === 'authors' ? 'authors'
    : tabParam === 'series' ? 'series'
    : 'books';
  const initialQuery = searchParams.get('q') || '';

  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const { cardSize, setCardSize, squareCovers, setSquareCovers } = usePreferences();

  // Debounce search query and sync to URL
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      const params = new URLSearchParams();
      if (tab !== 'books') params.set('tab', tab);
      const trimmed = query.trim();
      if (trimmed) params.set('q', trimmed);
      const qs = params.toString();
      router.replace(qs ? `/library?${qs}` : '/library', { scroll: false });
    }, 500);
    return () => clearTimeout(timer);
  }, [query, tab, router]);

  // Lazy-load tabs: only the active tab actually fetches. Avoids three
  // concurrent API calls on first mount when the user only sees one tab.
  const books   = useLibraryAudiobooks(debouncedQuery, 'addedAt_desc', tab === 'books');
  const authors = useLibraryAuthors(debouncedQuery, tab === 'authors');
  const series  = useLibrarySeries(debouncedQuery, tab === 'series');

  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
  }, []);

  // Infinite-scroll sentinel for the Books tab only. Authors and Series
  // are returned in full from a single API call (small lists) so they
  // don't need pagination — that's also what makes the A-Z jump rail
  // accurate from first paint.
  const booksSentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll({
    ref: booksSentinelRef,
    hasMore: tab === 'books' && books.hasMore,
    isLoading: books.isLoadingMore,
    onLoadMore: books.loadMore,
  });

  // Jump-to-letter: scroll the first item whose data-letter matches into view.
  // Walks the active tab's grid in the DOM rather than maintaining refs per
  // item, which would balloon at thousands of authors.
  const handleJump = useCallback((letter: string) => {
    if (typeof document === 'undefined') return;
    const containerSelector =
      tab === 'authors' ? '[data-grid="authors"]' :
      tab === 'series'  ? '[data-grid="series"]'  : null;
    if (!containerSelector) return;
    const container = document.querySelector(containerSelector);
    if (!container) return;
    const match = container.querySelector(`[data-letter="${letter}"]`);
    if (match) match.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (letter === 'A') container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tab]);

  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />

        <main className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
          {/* Page Header */}
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">
              Your Library
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Browse the audiobooks you already own
            </p>
          </div>

          {/* Tabs */}
          <div className="flex justify-center">
            <div className="inline-flex rounded-xl bg-gray-100 dark:bg-gray-800 p-1 border border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => handleTabChange('books')}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  tab === 'books'
                    ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                Books
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('authors')}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  tab === 'authors'
                    ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                Authors
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('series')}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  tab === 'series'
                    ? 'bg-white dark:bg-gray-900 text-emerald-600 dark:text-emerald-400 shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                Series
              </button>
            </div>
          </div>

          {/* Search Form */}
          <div className="max-w-3xl mx-auto">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  tab === 'books'   ? 'Filter books in your library...'
                  : tab === 'authors' ? 'Filter authors...'
                  : 'Filter series...'
                }
                className="w-full pl-12 pr-12 py-3 text-base border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  aria-label="Clear search"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Sticky Results Header */}
          <div className="sticky top-14 sm:top-16 z-30">
            <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-md rounded-2xl px-4 sm:px-6 py-3 border border-gray-200/50 dark:border-gray-700/50 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-gradient-to-b from-emerald-500 to-teal-500 rounded-full" />
                <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 truncate">
                  {tab === 'books' ? 'Books' : tab === 'authors' ? 'Authors' : 'Series'}
                </h2>
                {tab === 'books' && !books.isLoading && (
                  <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline whitespace-nowrap">
                    ({books.totalCount} {books.totalCount === 1 ? 'book' : 'books'})
                  </span>
                )}
                {tab === 'authors' && !authors.isLoading && (
                  <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline whitespace-nowrap">
                    ({authors.totalCount} {authors.totalCount === 1 ? 'author' : 'authors'})
                  </span>
                )}
                {tab === 'series' && !series.isLoading && (
                  <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline whitespace-nowrap">
                    ({series.totalCount} {series.totalCount === 1 ? 'series' : 'series'})
                  </span>
                )}
                {tab === 'books' && (
                  <div className="ml-auto flex items-center gap-1">
                    <SquareCoversToggle enabled={squareCovers} onToggle={setSquareCovers} />
                    <CardSizeControls size={cardSize} onSizeChange={setCardSize} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Results — Authors/Series tabs get a floating A-Z rail on the right */}
          {tab === 'books' ? (
            <div className="space-y-6">
              <AudiobookGrid
                audiobooks={books.audiobooks}
                isLoading={books.isLoading}
                emptyMessage={
                  debouncedQuery
                    ? `No books in your library match "${debouncedQuery}"`
                    : 'Your library is empty'
                }
                cardSize={cardSize}
                squareCovers={squareCovers}
              />
              {books.hasMore && (
                <div ref={booksSentinelRef} className="h-12 flex items-center justify-center">
                  {books.isLoadingMore && (
                    <span className="text-sm text-gray-500 dark:text-gray-400">Loading more…</span>
                  )}
                </div>
              )}
            </div>
          ) : tab === 'authors' ? (
            <div className="relative">
              <div className="space-y-6">
                {authors.isLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
                    ))}
                  </div>
                ) : authors.authors.length === 0 ? (
                  <div className="text-center py-16 text-gray-600 dark:text-gray-400">
                    {debouncedQuery
                      ? `No authors in your library match "${debouncedQuery}"`
                      : 'No authors found in your library'}
                  </div>
                ) : (
                  <div data-grid="authors" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 scroll-mt-32">
                    {authors.authors.map(a => (
                      <LibraryAuthorTile key={a.name} author={a} />
                    ))}
                  </div>
                )}
              </div>
              {authors.authors.length > 0 && (
                <AlphabetIndex
                  items={authors.authors}
                  getKey={a => a.name}
                  onJump={handleJump}
                  className="fixed right-2 top-1/2 -translate-y-1/2 z-40 bg-white/80 dark:bg-gray-900/80 backdrop-blur rounded-xl py-2 px-1 shadow-lg"
                />
              )}
            </div>
          ) : (
            // Series tab
            <div className="relative">
              <div className="space-y-6">
                {series.isLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 9 }).map((_, i) => (
                      <div key={i} className="h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
                    ))}
                  </div>
                ) : series.series.length === 0 ? (
                  <div className="text-center py-16 space-y-2 text-gray-600 dark:text-gray-400">
                    <p>
                      {debouncedQuery
                        ? `No series in your library match "${debouncedQuery}"`
                        : 'No series found in your library yet'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 max-w-md mx-auto">
                      Series listings depend on Audible metadata being resolved for owned books.
                      As more of your library matches against Audible, more series will appear here.
                    </p>
                  </div>
                ) : (
                  <div data-grid="series" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 scroll-mt-32">
                    {series.series.map(s => (
                      <LibrarySeriesTile key={s.title} series={s} />
                    ))}
                  </div>
                )}
              </div>
              {series.series.length > 0 && (
                <AlphabetIndex
                  items={series.series}
                  getKey={s => s.title}
                  onJump={handleJump}
                  className="fixed right-2 top-1/2 -translate-y-1/2 z-40 bg-white/80 dark:bg-gray-900/80 backdrop-blur rounded-xl py-2 px-1 shadow-lg"
                />
              )}
            </div>
          )}
        </main>
      </div>
    </ProtectedRoute>
  );
}

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryPageContent />
    </Suspense>
  );
}
