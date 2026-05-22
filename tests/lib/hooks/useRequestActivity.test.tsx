/**
 * Component: Request Activity Hook Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useSWRMock = vi.hoisted(() => vi.fn());
const authenticatedFetcherMock = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({ default: useSWRMock }));
vi.mock('@/lib/utils/api', () => ({ authenticatedFetcher: authenticatedFetcherMock }));

beforeEach(() => {
  useSWRMock.mockReset();
  authenticatedFetcherMock.mockReset();
  vi.resetModules();
});

describe('useRequestActivity', () => {
  it('polls every 5s while request is in an active status', async () => {
    useSWRMock.mockReturnValue({
      data: { events: [], nextCursor: null, requestStatus: 'downloading' },
      error: null, isLoading: false, mutate: vi.fn(),
    });
    const { useRequestActivity } = await import('@/lib/hooks/useRequestActivity');
    // Pass fallback status; the hook should also pick it up from data
    const Probe = () => { useRequestActivity('REQ', 'downloading'); return null; };
    render(<Probe />);
    expect(useSWRMock).toHaveBeenCalledWith(
      '/api/requests/REQ/activity?limit=50',
      authenticatedFetcherMock,
      expect.objectContaining({ refreshInterval: 5000 })
    );
  });

  it('stops polling (refreshInterval=0) when request is terminal', async () => {
    useSWRMock.mockReturnValue({
      data: { events: [], nextCursor: null, requestStatus: 'completed' },
      error: null, isLoading: false, mutate: vi.fn(),
    });
    const { useRequestActivity } = await import('@/lib/hooks/useRequestActivity');
    const Probe = () => { useRequestActivity('REQ', 'completed'); return null; };
    render(<Probe />);
    expect(useSWRMock).toHaveBeenCalledWith(
      '/api/requests/REQ/activity?limit=50',
      authenticatedFetcherMock,
      expect.objectContaining({ refreshInterval: 0 })
    );
  });

  it('returns null endpoint when requestId is null (does not fetch)', async () => {
    useSWRMock.mockReturnValue({ data: undefined, error: null, isLoading: false, mutate: vi.fn() });
    const { useRequestActivity } = await import('@/lib/hooks/useRequestActivity');
    const Probe = () => { useRequestActivity(null); return null; };
    render(<Probe />);
    expect(useSWRMock).toHaveBeenCalledWith(null, authenticatedFetcherMock, expect.any(Object));
  });

  it('treats failed/cancelled/denied/available as terminal', async () => {
    const { useRequestActivity } = await import('@/lib/hooks/useRequestActivity');
    for (const status of ['failed', 'cancelled', 'denied', 'available'] as const) {
      useSWRMock.mockClear();
      useSWRMock.mockReturnValue({ data: undefined, error: null, isLoading: false, mutate: vi.fn() });
      const Probe = () => { useRequestActivity('REQ', status); return null; };
      render(<Probe />);
      expect(useSWRMock).toHaveBeenLastCalledWith(
        '/api/requests/REQ/activity?limit=50',
        authenticatedFetcherMock,
        expect.objectContaining({ refreshInterval: 0 })
      );
    }
  });

  it('polls active states (pending, searching, downloading, processing) at 5s', async () => {
    const { useRequestActivity } = await import('@/lib/hooks/useRequestActivity');
    for (const status of ['pending', 'searching', 'downloading', 'processing'] as const) {
      useSWRMock.mockClear();
      useSWRMock.mockReturnValue({ data: undefined, error: null, isLoading: false, mutate: vi.fn() });
      const Probe = () => { useRequestActivity('REQ', status); return null; };
      render(<Probe />);
      expect(useSWRMock).toHaveBeenLastCalledWith(
        '/api/requests/REQ/activity?limit=50',
        authenticatedFetcherMock,
        expect.objectContaining({ refreshInterval: 5000 })
      );
    }
  });
});
