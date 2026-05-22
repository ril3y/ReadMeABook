/**
 * Component: Admin Stalled Downloads Page
 * Documentation: documentation/admin-features/stalled-downloads.md
 *
 * Visibility surface for the detect-stalled-downloads background processor:
 *   - Shows the configured timeout and last/next scheduled run
 *   - Lists requests that are currently past the timeout (will be swapped
 *     on the next pass)
 *   - Lists recent auto-swaps with their underlying release names
 *   - Provides a manual "Run now" trigger
 *
 * Auto-refreshes every 30s so admins can watch a manual run land.
 */

'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { authenticatedFetcher, fetchWithAuth } from '@/lib/utils/api';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { formatDistanceToNow } from 'date-fns';

interface StalledRequest {
  requestId: string;
  audiobook: {
    id: string;
    title: string;
    author: string;
    coverArtUrl: string | null;
  };
  progress: number;
  type: 'audiobook' | 'ebook';
  startedAt: string | null;
  stalledDays: number | null;
  torrentName: string | null;
  indexerName: string | null;
  downloadClient: string | null;
  downloadStatus: string | null;
}

interface SwapEntry {
  id: string;
  requestId: string;
  request: {
    id: string;
    status: string;
    type: string;
    audiobook: {
      id: string;
      title: string;
      author: string;
      coverArtUrl: string | null;
    };
  } | null;
  releaseName: string;
  indexerName: string | null;
  reason: string;
  createdAt: string;
}

interface GlobalBlock {
  releaseKey: string;
  releaseName: string;
  releaseHash: string | null;
  indexerName: string | null;
  reason: string;
  firstSeenAt: string;
  stallCount: number;
}

interface StalledData {
  config: {
    stallTimeoutDays: number;
    stallSwapMaxProgress: number;
    globalBlockThreshold: number;
    cutoffIso: string;
  };
  scheduledJob: {
    id: string;
    name: string;
    schedule: string;
    enabled: boolean;
    lastRun: string | null;
    lastRunJobId: string | null;
  } | null;
  counts: {
    currentlyStalled: number;
    activeDownloadingTotal: number;
    recentSwapsShown: number;
    globallyBlockedReleases: number;
    qbtTotal: number | null;
    qbtStalledPastCutoff: number | null;
  };
  qbtScanError: string | null;
  currentlyStalled: StalledRequest[];
  recentSwaps: SwapEntry[];
  globallyBlocked: GlobalBlock[];
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function StatPill({ label, value, tone = 'gray' }: { label: string; value: string | number; tone?: 'gray' | 'amber' | 'green' | 'red' }) {
  const toneMap = {
    gray: 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100',
    amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200',
    green: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-200',
    red: 'bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200',
  };
  return (
    <div className={`rounded-lg px-4 py-3 ${toneMap[tone]}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{value}</div>
    </div>
  );
}

function AdminStalledDownloadsContent() {
  const { data, error, isLoading, mutate } = useSWR<StalledData>(
    '/api/admin/stalled-downloads',
    authenticatedFetcher,
    {
      refreshInterval: 30_000,
      keepPreviousData: true,
    }
  );
  const [triggering, setTriggering] = useState(false);
  const toast = useToast();

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const res = await fetchWithAuth('/api/admin/stalled-downloads/trigger', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Trigger failed');
      }
      toast.success('Stall detection triggered — re-polling in 30s');
      // Bump SWR so the run-time updates quickly.
      setTimeout(() => mutate(), 3000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Trigger failed');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Stalled Downloads
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-3xl">
              Two-stage hourly pass. <strong>Stage 1</strong> swaps RMAB requests stuck in
              {' '}<code className="text-xs">downloading</code> past the timeout (deletes torrent +
              blocks release + queues new search). <strong>Stage 2</strong> scans qBT directly for
              orphan / stale-linked torrents past the cutoff and deletes them with files &mdash;
              this is what drains pre-existing qBT backlogs that RMAB never linked.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/settings"
              className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Settings
            </Link>
            <button
              type="button"
              onClick={handleTrigger}
              disabled={triggering}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-md"
            >
              {triggering ? 'Triggering…' : 'Run now'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
            Failed to load: {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        {isLoading && !data && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-10 text-center">
            Loading…
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <StatPill label="Timeout" value={`${data.config.stallTimeoutDays}d`} />
              <StatPill label="Swap below" value={`${data.config.stallSwapMaxProgress}%`} />
              <StatPill
                label="Globally blocked"
                value={data.counts.globallyBlockedReleases}
                tone={data.counts.globallyBlockedReleases > 0 ? 'red' : 'gray'}
              />
              <StatPill label="Active downloads" value={data.counts.activeDownloadingTotal} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
              <StatPill
                label="RMAB requests stalled (Stage 1)"
                value={data.counts.currentlyStalled}
                tone={data.counts.currentlyStalled > 0 ? 'amber' : 'green'}
              />
              <StatPill
                label="qBT stalled (Stage 2)"
                value={data.counts.qbtStalledPastCutoff ?? '—'}
                tone={(data.counts.qbtStalledPastCutoff ?? 0) > 0 ? 'amber' : 'green'}
              />
              <StatPill
                label="qBT total torrents"
                value={data.counts.qbtTotal ?? '—'}
              />
            </div>
            {data.qbtScanError && (
              <div className="mb-6 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-800 dark:text-amber-200">
                qBT-side scan unavailable: {data.qbtScanError}. Stage 2 will be skipped on the next pass.
              </div>
            )}

            <div className="mb-6 p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
              <div className="flex flex-col gap-1 text-gray-700 dark:text-gray-300">
                <div>
                  <span className="font-medium">Scheduler:</span>{' '}
                  {data.scheduledJob
                    ? (
                      <span>
                        {data.scheduledJob.enabled ? 'enabled' : 'disabled'} ·{' '}
                        <code className="text-xs">{data.scheduledJob.schedule}</code> · last
                        run {relTime(data.scheduledJob.lastRun)}
                      </span>
                    )
                    : <span className="text-gray-500">no schedule registered yet (will appear after first scheduler boot)</span>}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Cutoff: anything started before{' '}
                  <code className="text-xs">{data.config.cutoffIso}</code> · Global-block threshold: {data.config.globalBlockThreshold} stalls
                </div>
              </div>
            </div>

            <section className="mb-8">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Currently stalled ({data.counts.currentlyStalled})
              </h2>
              {data.currentlyStalled.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  Nothing past the timeout right now.
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-4 py-2">Title</th>
                        <th className="px-4 py-2">Author</th>
                        <th className="px-4 py-2">Stuck</th>
                        <th className="px-4 py-2">Progress</th>
                        <th className="px-4 py-2">Indexer</th>
                        <th className="px-4 py-2">Release</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {data.currentlyStalled.map((r) => (
                        <tr key={r.requestId} className="hover:bg-gray-50 dark:hover:bg-gray-900/40">
                          <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                            <Link
                              href={`/requests/${r.requestId}`}
                              className="hover:underline"
                            >
                              {r.audiobook.title}
                            </Link>
                          </td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{r.audiobook.author}</td>
                          <td className="px-4 py-2 text-amber-700 dark:text-amber-300 font-medium">
                            {r.stalledDays !== null ? `${r.stalledDays}d` : '—'}
                          </td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{r.progress}%</td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{r.indexerName ?? '—'}</td>
                          <td
                            className="px-4 py-2 text-gray-500 dark:text-gray-400 truncate max-w-[20ch]"
                            title={r.torrentName ?? undefined}
                          >
                            {r.torrentName ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.counts.currentlyStalled > data.currentlyStalled.length && (
                    <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900">
                      Showing first {data.currentlyStalled.length} of {data.counts.currentlyStalled}. Up to 50 are swapped per hourly pass.
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="mb-8">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Globally blocked releases ({data.counts.globallyBlockedReleases})
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 max-w-3xl">
                Releases that stalled {data.config.globalBlockThreshold}+ times across independent requests. <strong>No</strong> future automatic search will pick these &mdash; not just the requests that originally tried them. Unblock manually from <Link href="/admin/blocklist" className="underline">/admin/blocklist</Link> if needed.
              </p>
              {data.globallyBlocked.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  No releases have crossed the global-block threshold yet.
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-800 border border-red-200 dark:border-red-800 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-red-50 dark:bg-red-900/20 text-left text-xs uppercase tracking-wide text-red-700 dark:text-red-300">
                      <tr>
                        <th className="px-4 py-2">Release</th>
                        <th className="px-4 py-2">Stalls</th>
                        <th className="px-4 py-2">Indexer</th>
                        <th className="px-4 py-2">First seen</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {data.globallyBlocked.map((g) => (
                        <tr key={g.releaseKey} className="hover:bg-gray-50 dark:hover:bg-gray-900/40">
                          <td
                            className="px-4 py-2 text-gray-900 dark:text-gray-100 truncate max-w-[40ch]"
                            title={g.releaseName}
                          >
                            {g.releaseName}
                          </td>
                          <td className="px-4 py-2 text-red-700 dark:text-red-300 font-medium">{g.stallCount}</td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{g.indexerName ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400" title={g.firstSeenAt}>
                            {relTime(g.firstSeenAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Recent auto-swaps
              </h2>
              {data.recentSwaps.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  No swaps recorded yet. They&rsquo;ll appear here after the first hourly pass swaps a stalled release.
                </div>
              ) : (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-4 py-2">When</th>
                        <th className="px-4 py-2">Title</th>
                        <th className="px-4 py-2">Reason</th>
                        <th className="px-4 py-2">Release</th>
                        <th className="px-4 py-2">Indexer</th>
                        <th className="px-4 py-2">Now</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {data.recentSwaps.map((s) => (
                        <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/40">
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400" title={s.createdAt}>
                            {relTime(s.createdAt)}
                          </td>
                          <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                            {s.request ? (
                              <Link
                                href={`/requests/${s.requestId}`}
                                className="hover:underline"
                              >
                                {s.request.audiobook.title}
                              </Link>
                            ) : (
                              <span className="text-gray-400 italic">request deleted</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{s.reason}</td>
                          <td
                            className="px-4 py-2 text-gray-500 dark:text-gray-400 truncate max-w-[24ch]"
                            title={s.releaseName}
                          >
                            {s.releaseName}
                          </td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{s.indexerName ?? '—'}</td>
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                            {s.request?.status ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function AdminStalledDownloadsPage() {
  return (
    <Suspense fallback={null}>
      <ToastProvider>
        <AdminStalledDownloadsContent />
      </ToastProvider>
    </Suspense>
  );
}
