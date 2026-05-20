/**
 * Component: Request Activity Timeline
 * Documentation: documentation/frontend/components.md
 *
 * Renders the JobEvent timeline for a single Request. Groups consecutive
 * events from the same Job under a collapsible header so the user can
 * fold/unfold each step of the lifecycle.
 */

'use client';

import React from 'react';
import type { ActivityEvent } from '@/lib/hooks/useRequestActivity';

interface Props {
  events: ActivityEvent[];
  isLoading: boolean;
  requestStatus?: string;
}

const LEVEL_COLORS: Record<string, { dot: string; text: string }> = {
  info:  { dot: 'bg-emerald-500',  text: 'text-emerald-700 dark:text-emerald-300' },
  warn:  { dot: 'bg-amber-500',    text: 'text-amber-700 dark:text-amber-300' },
  error: { dot: 'bg-red-500',      text: 'text-red-700 dark:text-red-300' },
};

const JOB_TYPE_LABELS: Record<string, string> = {
  search_indexers:        'Search Indexers',
  monitor_download:       'Download',
  organize_files:         'Organize Files',
  scan_plex:              'Library Scan',
  start_direct_download:  'Direct Download',
  monitor_direct_download:'Monitor Download',
  search_ebook:           'Search (Ebook)',
};

function humanJobType(type: string): string {
  return JOB_TYPE_LABELS[type] ||
    type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function MetadataDetails({ metadata }: { metadata: unknown }) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata === 'object' && Object.keys(metadata as object).length === 0) {
    return null;
  }
  let pretty: string;
  try {
    pretty = JSON.stringify(metadata, null, 2);
  } catch {
    pretty = String(metadata);
  }
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
        show details
      </summary>
      <pre className="mt-2 p-3 text-xs bg-gray-50 dark:bg-gray-900 rounded-lg overflow-x-auto text-gray-700 dark:text-gray-300">
        {pretty}
      </pre>
    </details>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const colors = LEVEL_COLORS[event.level] || LEVEL_COLORS.info;
  return (
    <li className="relative pl-6 pb-4">
      {/* Timeline rail dot */}
      <span
        className={`absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full ring-4 ring-white dark:ring-gray-900 ${colors.dot}`}
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${colors.text} bg-gray-100 dark:bg-gray-800`}>
          {event.context}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500" title={event.timestamp}>
          {formatRelative(event.timestamp)}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-800 dark:text-gray-200 break-words">
        {event.message}
      </p>
      <MetadataDetails metadata={event.metadata} />
    </li>
  );
}

function JobGroup({ jobId, jobType, jobStatus, events }: {
  jobId: string;
  jobType: string;
  jobStatus: string;
  events: ActivityEvent[];
}) {
  const statusColor =
    jobStatus === 'completed' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200'
    : jobStatus === 'failed'  ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200'
    : jobStatus === 'active'  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200'
    :                            'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {humanJobType(jobType)}
        </h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>
          {jobStatus}
        </span>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 font-mono">
          {jobId.slice(0, 8)}
        </span>
      </div>
      <ol className="relative ml-1 border-l-2 border-gray-200 dark:border-gray-700">
        {events.map(e => <EventRow key={e.id} event={e} />)}
      </ol>
    </div>
  );
}

export function RequestActivityTimeline({ events, isLoading, requestStatus }: Props) {
  if (isLoading && events.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-gray-700 dark:text-gray-300">No activity recorded yet</p>
        <p className="text-xs text-gray-500 dark:text-gray-500 max-w-md mx-auto">
          {requestStatus && requestStatus !== 'pending'
            ? 'This request hasn\'t emitted any job events. It may be too old, or its jobs have been purged.'
            : 'Queued. Events will appear here once searching begins.'}
        </p>
      </div>
    );
  }

  // Group consecutive events by jobId so the timeline reads job-by-job.
  // Events arrive newest-first; we preserve that ordering.
  const groups: { jobId: string; jobType: string; jobStatus: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.jobId === e.jobId) {
      last.events.push(e);
    } else {
      groups.push({ jobId: e.jobId, jobType: e.jobType, jobStatus: e.jobStatus, events: [e] });
    }
  }

  return (
    <div className="space-y-4">
      {groups.map((g, i) => (
        <JobGroup key={`${g.jobId}-${i}`} {...g} />
      ))}
    </div>
  );
}
