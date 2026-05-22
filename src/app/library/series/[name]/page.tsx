/**
 * Component: Library Series Detail Page
 * Documentation: documentation/frontend/components.md
 *
 * Shows every owned book in one library series, by display-name handle
 * (plex_library.series — no ASIN required). When we have a resolved
 * seriesAsin + cached totalBooks, the header surfaces "X / Y total" and
 * offers links to the full Audible catalog. When we don't, just lists
 * the owned books — clicking a tile from /library?tab=series now always
 * lands on something useful, not a generic search page.
 */

'use client';

import { use as usePromise } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { useLibrarySeriesDetail } from '@/lib/hooks/useLibrarySeriesDetail';
import { CardSizeControls } from '@/components/ui/CardSizeControls';
import { SquareCoversToggle } from '@/components/ui/SquareCoversToggle';
import { usePreferences } from '@/contexts/PreferencesContext';

interface PageProps {
  params: Promise<{ name: string }>;
}

function LibrarySeriesContent({ name }: { name: string }) {
  const { series, books, bookCount, seriesAsin, totalBooks, author, isLoading, error } =
    useLibrarySeriesDetail(name);
  const { cardSize, setCardSize, squareCovers, setSquareCovers } = usePreferences();

  if (error) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-red-700 dark:text-red-300">
          <p className="font-medium">Couldn&rsquo;t load this series.</p>
          <Link href="/library?tab=series" className="inline-block mt-3 text-sm underline">
            ← Back to Series
          </Link>
        </div>
      </main>
    );
  }

  const missing = totalBooks !== null ? Math.max(0, totalBooks - bookCount) : null;

  return (
    <main className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
      <div>
        <Link
          href="/library?tab=series"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← Back to Series
        </Link>
      </div>

      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100">
            {series}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            {isLoading
              ? 'Loading…'
              : (
                <>
                  {totalBooks !== null
                    ? <><strong>{bookCount}</strong> owned · <strong>{totalBooks}</strong> total{missing && missing > 0 ? <> · <strong className="text-amber-700 dark:text-amber-300">{missing} missing</strong></> : null}</>
                    : <><strong>{bookCount}</strong> {bookCount === 1 ? 'book' : 'books'} owned</>}
                  {author ? <> · {author}</> : null}
                </>
              )}
          </p>
        </div>

        {/* When we have a resolved seriesAsin, deep-link to the full Audible
            catalog page where the Fill-gaps button + per-book request UI live. */}
        {seriesAsin && (
          <Link
            href={`/series/${seriesAsin}`}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
          >
            View full series catalog on Audible
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>
        )}

        {/* When we DON'T have a seriesAsin yet, surface that we'll find it
            in the daily backfill pass so the user understands why the
            "View catalog" link isn't here. */}
        {!isLoading && !seriesAsin && (
          <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
            Audible series catalog not yet resolved for this series. The daily
            backfill pass will look it up automatically.
          </div>
        )}
      </header>

      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Books in your library
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <SquareCoversToggle enabled={squareCovers} onToggle={setSquareCovers} />
            <CardSizeControls size={cardSize} onSizeChange={setCardSize} />
          </div>
        </div>
        <AudiobookGrid
          audiobooks={books}
          isLoading={isLoading}
          emptyMessage={`No books found in your library for "${series}"`}
          cardSize={cardSize}
          squareCovers={squareCovers}
        />
      </section>
    </main>
  );
}

export default function LibrarySeriesPage({ params }: PageProps) {
  const { name } = usePromise(params);
  const decoded = decodeURIComponent(name || '');
  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />
        <LibrarySeriesContent name={decoded} />
      </div>
    </ProtectedRoute>
  );
}
