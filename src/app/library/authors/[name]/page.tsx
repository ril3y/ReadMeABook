/**
 * Component: Library Author Detail Page
 * Documentation: documentation/frontend/components.md
 *
 * Shows every owned book by one author plus the series they appear in.
 * Routed from the Author tile on /library?tab=authors.
 *
 * The author "name" path segment is the URL-encoded plain author string
 * from plex_library.author — that's the only stable handle we have.
 */

'use client';

import { use as usePromise } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { useLibraryAuthorDetail } from '@/lib/hooks/useLibraryAuthorDetail';
import { CardSizeControls } from '@/components/ui/CardSizeControls';
import { SquareCoversToggle } from '@/components/ui/SquareCoversToggle';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { LibrarySeries } from '@/lib/hooks/useLibrarySeries';

interface PageProps {
  params: Promise<{ name: string }>;
}

function SeriesTile({ series }: { series: LibrarySeries }) {
  const href = series.asin
    ? `/series/${series.asin}`
    : `/search?q=${encodeURIComponent(series.title)}`;
  return (
    <Link
      href={href}
      className="group block p-3 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200/70 dark:border-gray-700/70 hover:border-emerald-400 dark:hover:border-emerald-500 hover:shadow-md transition-all"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-emerald-600 dark:group-hover:text-emerald-400">
          {series.title}
        </h3>
        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200">
          {series.bookCount}
        </span>
      </div>
    </Link>
  );
}

function AuthorDetailContent({ name }: { name: string }) {
  const { author, books, series, bookCount, seriesCount, isLoading, error } =
    useLibraryAuthorDetail(name);
  const { cardSize, setCardSize, squareCovers, setSquareCovers } = usePreferences();

  if (error) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-red-700 dark:text-red-300">
          <p className="font-medium">Couldn't load this author.</p>
          <Link href="/library?tab=authors" className="inline-block mt-3 text-sm underline">
            ← Back to Authors
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
      <div>
        <Link
          href="/library?tab=authors"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← Back to Authors
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100">
          {author}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          {isLoading ? 'Loading…' :
            `${bookCount} ${bookCount === 1 ? 'book' : 'books'}` +
            (seriesCount > 0 ? ` · ${seriesCount} ${seriesCount === 1 ? 'series' : 'series'}` : '')}
        </p>
      </header>

      {/* Series for this author (compact) */}
      {series.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Series
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {series.map(s => <SeriesTile key={s.title} series={s} />)}
          </div>
        </section>
      )}

      {/* Books */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Books
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <SquareCoversToggle enabled={squareCovers} onToggle={setSquareCovers} />
            <CardSizeControls size={cardSize} onSizeChange={setCardSize} />
          </div>
        </div>
        <AudiobookGrid
          audiobooks={books}
          isLoading={isLoading}
          emptyMessage={`No books found in your library for ${author}`}
          cardSize={cardSize}
          squareCovers={squareCovers}
        />
      </section>
    </main>
  );
}

export default function LibraryAuthorPage({ params }: PageProps) {
  const { name } = usePromise(params);
  const decoded = decodeURIComponent(name || '');
  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />
        <AuthorDetailContent name={decoded} />
      </div>
    </ProtectedRoute>
  );
}
