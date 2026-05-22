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

import { use as usePromise, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { LoadMoreBar } from '@/components/ui/LoadMoreBar';
import { useLibrarySeriesDetail } from '@/lib/hooks/useLibrarySeriesDetail';
import { useSeriesDetail } from '@/lib/hooks/useSeries';
import { CardSizeControls } from '@/components/ui/CardSizeControls';
import { SquareCoversToggle } from '@/components/ui/SquareCoversToggle';
import { usePreferences } from '@/contexts/PreferencesContext';
import { fetchWithAuth } from '@/lib/utils/api';
import type { Audiobook } from '@/lib/hooks/useAudiobooks';

interface PageProps {
  params: Promise<{ name: string }>;
}

function LibrarySeriesContent({ name }: { name: string }) {
  const { series, books, bookCount, seriesAsin, totalBooks, author, isLoading, error } =
    useLibrarySeriesDetail(name);
  // When we have a resolved seriesAsin, ALSO fetch the full Audible catalog
  // (same hook the /series/[asin] page uses). Catalog books carry
  // isAvailable flags set server-side by matching plex_library — so the
  // resulting grid shows owned books normally + missing books grayed out
  // with a red MISSING badge (highlightMissing on AudiobookGrid).
  const {
    series: catalogSeries,
    hasMore: catalogHasMore,
    isLoadingMore: catalogLoadingMore,
    loadMore: loadMoreCatalog,
  } = useSeriesDetail(seriesAsin);
  const { cardSize, setCardSize, squareCovers, setSquareCovers } = usePreferences();

  // Fill-gaps state: queues the find-missing-series-books processor in
  // single-series mode for this seriesAsin so RMAB requests every book in
  // the Audible catalog the user doesn't already own.
  const [fillingGaps, setFillingGaps] = useState(false);
  const [fillMessage, setFillMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const handleFillGaps = useCallback(async () => {
    if (!seriesAsin) return;
    setFillingGaps(true);
    setFillMessage(null);
    try {
      const res = await fetchWithAuth(`/api/series/${seriesAsin}/fill-gaps`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setFillMessage({
        kind: 'success',
        text: 'Queued — missing books will appear as new requests within a minute.',
      });
    } catch (err) {
      setFillMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Fill-gaps failed',
      });
    } finally {
      setFillingGaps(false);
    }
  }, [seriesAsin]);

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

        {/* When we have a resolved seriesAsin AND there are missing books,
            offer the one-click "Request all missing" action that queues the
            find-missing-series-books processor in single-series mode.
            Plus a secondary deep-link to the full Audible catalog view. */}
        {seriesAsin && (
          <div className="flex flex-wrap items-center gap-3">
            {missing !== null && missing > 0 && (
              <button
                onClick={handleFillGaps}
                disabled={fillingGaps}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 rounded-md"
              >
                {fillingGaps ? 'Queueing…' : `Request all ${missing} missing book${missing === 1 ? '' : 's'}`}
              </button>
            )}
            <Link
              href={`/series/${seriesAsin}`}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              View full catalog on Audible
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </Link>
          </div>
        )}
        {fillMessage && (
          <div
            className={`rounded-lg p-3 text-sm ${
              fillMessage.kind === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
            }`}
          >
            {fillMessage.text}
          </div>
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
            {usingCatalogView ? 'Books in this series' : 'Books in your library'}
          </h2>
          {usingCatalogView && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              (greyed-out covers are missing from your library)
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <SquareCoversToggle enabled={squareCovers} onToggle={setSquareCovers} />
            <CardSizeControls size={cardSize} onSizeChange={setCardSize} />
          </div>
        </div>
        <AudiobookGrid
          audiobooks={displayBooks}
          isLoading={isLoading}
          emptyMessage={`No books found in your library for "${series}"`}
          cardSize={cardSize}
          squareCovers={squareCovers}
          highlightMissing={usingCatalogView}
        />
        {/* Paginated catalog view: load remaining pages of the Audible
            series so missing-book tiles aren't truncated at page 1. */}
        {usingCatalogView && displayBooks.length > 0 && (
          <LoadMoreBar
            loadedCount={displayBooks.length}
            totalCount={catalogSeries?.bookCount && catalogSeries.bookCount > 0 ? catalogSeries.bookCount : undefined}
            hasMore={catalogHasMore}
            isLoading={catalogLoadingMore}
            onLoadMore={loadMoreCatalog}
          />
        )}
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
