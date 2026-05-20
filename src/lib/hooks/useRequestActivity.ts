/**
 * Component: Request Activity Hook
 * Documentation: documentation/frontend/components.md
 *
 * Polls /api/requests/[id]/activity at 5s (matching /requests page
 * cadence). Stops polling once the request reaches a terminal state.
 */

'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { authenticatedFetcher } from '@/lib/utils/api';

const TERMINAL_STATUSES = new Set([
  'completed', 'available', 'cancelled', 'failed', 'denied',
]);

export interface ActivityEvent {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | string;
  context: string;
  message: string;
  metadata: unknown | null;
  metadataTruncated?: boolean;
  jobId: string;
  jobType: string;
  jobStatus: string;
}

interface ActivityResponse {
  success: boolean;
  events: ActivityEvent[];
  nextCursor: string | null;
  requestStatus: string;
}

export function useRequestActivity(
  requestId: string | null,
  fallbackStatus?: string
) {
  const endpoint = requestId
    ? `/api/requests/${requestId}/activity?limit=50`
    : null;

  // Track the latest observed requestStatus separately from the SWR cache
  // so the refreshInterval option can react to it without a circular ref.
  // Seed with the caller-supplied fallback so polling starts on first render.
  const [observedStatus, setObservedStatus] = useState<string | undefined>(fallbackStatus);
  const isTerminal = !!observedStatus && TERMINAL_STATUSES.has(observedStatus);

  const { data, error, isLoading, mutate } = useSWR<ActivityResponse>(
    endpoint,
    authenticatedFetcher,
    {
      // Stop polling once we observe a terminal state. Using the activity
      // response's own status (via onSuccess) means we don't depend on the
      // parent's separate detail-SWR — if that one stalls or fails, we'd
      // otherwise poll forever for a request that's actually finished.
      refreshInterval: isTerminal ? 0 : 5000,
      revalidateOnFocus: false,
      dedupingInterval: 2000,
      onSuccess: (resp) => {
        if (resp?.requestStatus && resp.requestStatus !== observedStatus) {
          setObservedStatus(resp.requestStatus);
        }
      },
    }
  );

  return {
    events: data?.events ?? [],
    nextCursor: data?.nextCursor ?? null,
    requestStatus: data?.requestStatus,
    isLoading,
    error,
    mutate,
  };
}
