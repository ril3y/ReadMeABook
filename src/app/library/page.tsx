/**
 * Component: Library Page
 * Documentation: documentation/frontend/components.md
 *
 * Browse the owned audiobook library by Books or Authors. Driven by the
 * existing plex_library table (works for both Plex and Audiobookshelf
 * backends). Search box filters within the active tab.
 */

'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { useLibraryAudiobooks } from '@/lib/hooks/useLibraryAudiobooks';
import { useLibraryAuthors, type LibraryAuthor } from '@/lib/hooks/useLibraryAuthors';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { CardSizeControls } from '@/components/ui/CardSizeControls';
import { SquareCoversToggle } from '@/components/ui/SquareCoversToggle';
import { usePreferences } from '@/contexts/PreferencesContext';

type Tab = 'books' | 'authors';

function LibraryAuthorTile({ author }: { author: LibraryAuthor }) {
  const href = `/search?q=${encodeURIComponent(author.name)}`;
  return (
    <Link
      href={href}
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

function LibraryPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const initialTab = (searchParams.get('tab') as Tab) === 'authors' ? 'authors' : 'books';
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

  const books = useLibraryAudiobooks(debouncedQuery);
  const authors = useLibraryAuthors(debouncedQuery);

  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
  }, []);

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
                placeholder={tab === 'books' ? 'Filter books in your library...' : 'Filter authors...'}
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
                  {tab === 'books' ? 'Books' : 'Authors'}
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
                {tab === 'books' && (
                  <div className="ml-auto flex items-center gap-1">
                    <SquareCoversToggle enabled={squareCovers} onToggle={setSquareCovers} />
                    <CardSizeControls size={cardSize} onSizeChange={setCardSize} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Results */}
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
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={books.loadMore}
                    disabled={books.isLoadingMore}
                    className="px-6 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {books.isLoadingMore ? 'Loading...' : 'Load more'}
                  </button>
                </div>
              )}
            </div>
          ) : (
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
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {authors.authors.map(a => (
                      <LibraryAuthorTile key={a.name} author={a} />
                    ))}
                  </div>
                  {authors.hasMore && (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        onClick={authors.loadMore}
                        disabled={authors.isLoadingMore}
                        className="px-6 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        {authors.isLoadingMore ? 'Loading...' : 'Load more'}
                      </button>
                    </div>
                  )}
                </>
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
