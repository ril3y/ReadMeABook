/**
 * Component: Request Detail Page
 * Documentation: documentation/frontend/components.md
 *
 * Per-request detail page showing the lifecycle activity timeline.
 * MVP renders one tab ("Activity") — page structure leaves room for
 * additional tabs (Overview, Files, History) without restructuring.
 */

'use client';

import { use as usePromise } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Header } from '@/components/layout/Header';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { StatusBadge } from '@/components/requests/StatusBadge';
import { RequestActivityTimeline } from '@/components/requests/RequestActivityTimeline';
import { useRequestActivity } from '@/lib/hooks/useRequestActivity';
import { authenticatedFetcher } from '@/lib/utils/api';

interface RequestDetail {
  id: string;
  status: string;
  progress: number;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
  audiobook: {
    title: string;
    author: string;
    narrator?: string | null;
    coverArtUrl?: string | null;
    audibleAsin?: string | null;
    series?: string | null;
    seriesPart?: string | null;
  };
}

interface RequestDetailResponse {
  success: boolean;
  request: RequestDetail;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

function RequestDetailContent({ id }: { id: string }) {
  const { data, error, isLoading: detailLoading } = useSWR<RequestDetailResponse>(
    `/api/requests/${id}`,
    authenticatedFetcher,
    { refreshInterval: 5000, revalidateOnFocus: false }
  );

  const request = data?.request;
  const activity = useRequestActivity(id, request?.status);

  if (error) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-3xl">
        <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-red-700 dark:text-red-300">
          <p className="font-medium">Couldn't load this request.</p>
          <p className="text-sm mt-1">
            It may have been deleted or you may not have access to it.
          </p>
          <Link href="/requests" className="inline-block mt-4 text-sm underline">
            ← Back to My Requests
          </Link>
        </div>
      </main>
    );
  }

  if (detailLoading && !request) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-3xl space-y-4">
        <div className="h-8 w-2/3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-24 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />
        <div className="h-64 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />
      </main>
    );
  }

  if (!request) return null;

  return (
    <main className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
      <div>
        <Link
          href="/requests"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← Back to My Requests
        </Link>
      </div>

      {/* Header */}
      <header className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 sm:p-6">
        <div className="flex gap-4">
          {request.audiobook.coverArtUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={request.audiobook.coverArtUrl}
              alt={request.audiobook.title}
              className="w-20 sm:w-24 aspect-[2/3] object-cover rounded-lg flex-shrink-0"
            />
          ) : (
            <div className="w-20 sm:w-24 aspect-[2/3] rounded-lg bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">
              {request.audiobook.title}
            </h1>
            <p className="text-gray-600 dark:text-gray-400">{request.audiobook.author}</p>
            {request.audiobook.narrator && (
              <p className="text-xs text-gray-500 dark:text-gray-500">
                Narrated by {request.audiobook.narrator}
              </p>
            )}
            {request.audiobook.series && (
              <p className="text-xs text-gray-500 dark:text-gray-500">
                {request.audiobook.series}
                {request.audiobook.seriesPart && ` · #${request.audiobook.seriesPart}`}
              </p>
            )}
            <div className="pt-1">
              <StatusBadge status={request.status as never} />
            </div>
          </div>
        </div>
        {request.status === 'downloading' && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
              <span>Progress</span>
              <span>{request.progress}%</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-purple-600 transition-all duration-300"
                style={{ width: `${request.progress}%` }}
              />
            </div>
          </div>
        )}
        {request.errorMessage && (
          <div className="mt-4 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
            {request.errorMessage}
          </div>
        )}
      </header>

      {/* Tabs (single Activity tab in MVP) */}
      <div>
        <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700">
          <button
            type="button"
            className="px-4 py-2 text-sm font-medium border-b-2 border-blue-600 text-blue-600 dark:text-blue-400"
          >
            Activity
          </button>
        </div>
        <div className="pt-4">
          <RequestActivityTimeline
            events={activity.events}
            isLoading={activity.isLoading}
            requestStatus={request.status}
          />
        </div>
      </div>
    </main>
  );
}

export default function RequestDetailPage({ params }: PageProps) {
  const { id } = usePromise(params);
  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />
        <RequestDetailContent id={id} />
      </div>
    </ProtectedRoute>
  );
}
