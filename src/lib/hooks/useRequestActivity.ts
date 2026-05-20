/**
 * Component: Request Activity Hook
 * Documentation: documentation/frontend/components.md
 *
 * Polls /api/requests/[id]/activity at 5s (matching /requests page
 * cadence). Stops polling once the request reaches a terminal state.
 */

'use client';

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
  requestStatus?: string
) {
  const endpoint = requestId
    ? `/api/requests/${requestId}/activity?limit=50`
    : null;

  const isTerminal = !!requestStatus && TERMINAL_STATUSES.has(requestStatus);

  const { data, error, isLoading, mutate } = useSWR<ActivityResponse>(
    endpoint,
    authenticatedFetcher,
    {
      // Poll every 5s while the request is still active; stop once terminal.
      refreshInterval: isTerminal ? 0 : 5000,
      revalidateOnFocus: false,
      dedupingInterval: 2000,
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
