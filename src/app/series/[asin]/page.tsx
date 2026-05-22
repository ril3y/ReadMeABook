/**
 * Component: Series Detail Page
 * Documentation: documentation/frontend/components.md
 */

'use client';

import { use, useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { LoadMoreBar } from '@/components/ui/LoadMoreBar';
import { SeriesDetailCard, SeriesDetailSkeleton } from '@/components/series/SeriesDetailCard';
import { SimilarSeriesRow, SimilarSeriesSkeleton } from '@/components/series/SimilarSeriesRow';
import { useSeriesDetail } from '@/lib/hooks/useSeries';
import { Audiobook } from '@/lib/hooks/useAudiobooks';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { SectionToolbar } from '@/components/ui/SectionToolbar';
import { usePreferences } from '@/contexts/PreferencesContext';
import { fetchWithAuth } from '@/lib/utils/api';

export default function SeriesDetailPage({
  params,
}: {
  params: Promise<{ asin: string }>;
}) {
  const { asin } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromSeriesTitle = searchParams.get('from');
  const { series, hasMore, isLoading: seriesLoading, isLoadingMore, loadMore } = useSeriesDetail(asin);
  const { cardSize, setCardSize, squareCovers, setSquareCovers, hideAvailable, setHideAvailable } = usePreferences();

  // Per-series "Fill missing books" state. Counts missing books visually,
  // POSTs to the fill-gaps API, surfaces success/error inline.
  const [fillingGaps, setFillingGaps] = useState(false);
  const [fillMessage, setFillMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const missingCount = useMemo(
    () =>
      series
        ? series.books.filter((b: Audiobook) => !b.isAvailable && b.requestStatus !== 'completed').length
        : 0,
    [series]
  );

  const handleFillGaps = useCallback(async () => {
    setFillingGaps(true);
    setFillMessage(null);
    try {
      const res = await fetchWithAuth(`/api/series/${asin}/fill-gaps`, { method: 'POST' });
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
  }, [asin]);

  const handleBack = useCallback(() => {
    // Use browser back if we came from within the app, otherwise fallback to /series
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push('/series');
    }
  }, [router]);

  // Filter out available titles when hideAvailable is enabled
  const filteredBooks = useMemo(
    () => series && hideAvailable
      ? series.books.filter((b: Audiobook) => !b.isAvailable && b.requestStatus !== 'completed')
      : series?.books ?? [],
    [series, hideAvailable]
  );

  // Header count text: reflects filtered counts
  const visibleCount = filteredBooks.length;
  const booksCountText = series
    ? hasMore && series.bookCount > series.books.length
      ? `${visibleCount.toLocaleString()} of ${series.bookCount.toLocaleString()} title${series.bookCount !== 1 ? 's' : ''}`
      : visibleCount > 0
        ? `${visibleCount.toLocaleString()} title${visibleCount !== 1 ? 's' : ''}`
        : ''
    : '';

  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />

        <main className="container mx-auto px-4 py-6 sm:py-8 max-w-7xl space-y-8">
          {/* Back navigation */}
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {fromSeriesTitle ? `Back to ${fromSeriesTitle}` : 'Back to Series'}
          </button>

          {/* Series Detail Card */}
          {seriesLoading ? (
            <SeriesDetailSkeleton squareCovers={squareCovers} />
          ) : series ? (
            <>
              <SeriesDetailCard series={series} squareCovers={squareCovers} hasMore={hasMore} />
              {/* Fill-gaps action: creates Requests for every missing book
                  in this series so the user doesn't have to click each one. */}
              {missingCount > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-0 text-sm text-amber-900 dark:text-amber-200">
                    <strong>{missingCount}</strong> book{missingCount === 1 ? '' : 's'} missing from this series in your library.
                  </div>
                  <button
                    onClick={handleFillGaps}
                    disabled={fillingGaps}
                    className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 rounded-md"
                  >
                    {fillingGaps ? 'Queueing…' : 'Request all missing'}
                  </button>
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
            </>
          ) : (
            <div className="text-center py-16 space-y-4">
              <svg className="mx-auto h-16 w-16 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-xl text-gray-600 dark:text-gray-400">Series not found</p>
            </div>
          )}

          {/* Similar Series */}
          {seriesLoading ? (
            <SimilarSeriesSkeleton squareCovers={squareCovers} />
          ) : series && series.similarSeries.length > 0 ? (
            <SimilarSeriesRow series={series.similarSeries} currentSeriesTitle={series.title} squareCovers={squareCovers} />
          ) : null}

          {/* Books Section */}
          {series && (
            <div className="space-y-6">
              {/* Sticky Books Header */}
              <div className="sticky top-14 sm:top-16 z-30">
                <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-md rounded-2xl px-4 sm:px-6 py-3 border border-gray-200/50 dark:border-gray-700/50 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-1 h-6 bg-gradient-to-b from-blue-500 to-purple-500 rounded-full" />
                    <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 truncate">
                      Books in Series
                    </h2>
                    {booksCountText && (
                      <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline whitespace-nowrap">
                        ({booksCountText})
                      </span>
                    )}
                    <SectionToolbar
                      hideAvailable={hideAvailable}
                      onToggleHideAvailable={setHideAvailable}
                      squareCovers={squareCovers}
                      onToggleSquareCovers={setSquareCovers}
                      cardSize={cardSize}
                      onCardSizeChange={setCardSize}
                    />
                  </div>
                </div>
              </div>

              {/* Books Grid — highlight missing books so users can spot
                  gaps in the series at a glance. The Request action is
                  already accessible via the standard hover overlay. */}
              <AudiobookGrid
                audiobooks={filteredBooks}
                isLoading={seriesLoading}
                emptyMessage={`No books found for ${series.title}`}
                cardSize={cardSize}
                squareCovers={squareCovers}
                highlightMissing
              />

              {/* Load More Bar */}
              {filteredBooks.length > 0 && (
                <LoadMoreBar
                  loadedCount={filteredBooks.length}
                  totalCount={series.bookCount > 0 ? series.bookCount : undefined}
                  hasMore={hasMore}
                  isLoading={isLoadingMore}
                  onLoadMore={loadMore}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </ProtectedRoute>
  );
}
