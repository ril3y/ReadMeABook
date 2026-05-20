/**
 * Component: Request Detail Page Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockAuthState } from '../helpers/mock-auth';
import { resetMockRouter } from '../helpers/mock-next-navigation';

const useSWRMock = vi.hoisted(() => vi.fn());
const useRequestActivityMock = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({ default: useSWRMock }));

vi.mock('@/lib/hooks/useRequestActivity', () => ({
  useRequestActivity: useRequestActivityMock,
}));

vi.mock('@/lib/utils/api', () => ({
  authenticatedFetcher: vi.fn(),
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock('@/components/requests/StatusBadge', () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock('@/components/requests/RequestActivityTimeline', () => ({
  RequestActivityTimeline: ({ events, isLoading, requestStatus }: any) => (
    <div data-testid="timeline" data-status={requestStatus} data-loading={String(!!isLoading)}>
      events={events.length}
    </div>
  ),
}));

function paramsFor(id: string) {
  return Promise.resolve({ id });
}

describe('RequestDetailPage', () => {
  beforeEach(() => {
    resetMockAuthState();
    resetMockRouter();
    useSWRMock.mockReset();
    useRequestActivityMock.mockReset();
    useRequestActivityMock.mockReturnValue({
      events: [], nextCursor: null, isLoading: false, error: null, mutate: vi.fn(),
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders header + title + author + status badge + timeline', async () => {
    useSWRMock.mockReturnValue({
      data: {
        success: true,
        request: {
          id: 'REQ',
          status: 'downloading',
          progress: 42,
          createdAt: '2025-01-01T00:00:00Z',
          audiobook: {
            title: 'Project Hail Mary',
            author: 'Andy Weir',
            narrator: 'Ray Porter',
            coverArtUrl: null,
            audibleAsin: 'B08GB58KD5',
            series: null,
            seriesPart: null,
          },
        },
      },
      error: null, isLoading: false,
    });
    useRequestActivityMock.mockReturnValue({
      events: [{ id: 'e1' }, { id: 'e2' }],
      nextCursor: null, isLoading: false, error: null, mutate: vi.fn(),
    });

    const { default: Page } = await import('@/app/requests/[id]/page');
    render(<Page params={paramsFor('REQ')} />);

    // Wait a tick for params promise to resolve in usePromise
    await new Promise(r => setTimeout(r, 0));

    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
    expect(screen.getByText('Andy Weir')).toBeInTheDocument();
    expect(screen.getByText(/Narrated by Ray Porter/i)).toBeInTheDocument();
    expect(screen.getByTestId('status-badge')).toHaveTextContent('downloading');
    const tl = screen.getByTestId('timeline');
    expect(tl).toHaveAttribute('data-status', 'downloading');
    expect(tl).toHaveTextContent('events=2');
  });

  it('renders a progress bar only while status is downloading', async () => {
    useSWRMock.mockReturnValue({
      data: {
        success: true,
        request: {
          id: 'REQ', status: 'downloading', progress: 75,
          createdAt: '2025-01-01T00:00:00Z',
          audiobook: { title: 'X', author: 'Y' },
        },
      },
      error: null, isLoading: false,
    });

    const { default: Page } = await import('@/app/requests/[id]/page');
    render(<Page params={paramsFor('REQ')} />);
    await new Promise(r => setTimeout(r, 0));

    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
  });

  it('shows an error panel when the request fetch errors', async () => {
    useSWRMock.mockReturnValue({
      data: undefined,
      error: new Error('boom'),
      isLoading: false,
    });

    const { default: Page } = await import('@/app/requests/[id]/page');
    render(<Page params={paramsFor('REQ')} />);
    await new Promise(r => setTimeout(r, 0));

    expect(screen.getByText(/Couldn't load this request/i)).toBeInTheDocument();
    expect(screen.getByText(/Back to My Requests/i)).toBeInTheDocument();
  });

  it('shows loading skeleton when fetch is in flight with no data', async () => {
    useSWRMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    const { default: Page } = await import('@/app/requests/[id]/page');
    const { container } = render(<Page params={paramsFor('REQ')} />);
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows error message when the request has one', async () => {
    useSWRMock.mockReturnValue({
      data: {
        success: true,
        request: {
          id: 'REQ', status: 'failed', progress: 0,
          errorMessage: 'No matching torrent found',
          createdAt: '2025-01-01T00:00:00Z',
          audiobook: { title: 'X', author: 'Y' },
        },
      },
      error: null, isLoading: false,
    });

    const { default: Page } = await import('@/app/requests/[id]/page');
    render(<Page params={paramsFor('REQ')} />);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.getByText('No matching torrent found')).toBeInTheDocument();
  });

  it('renders series + seriesPart when present', async () => {
    useSWRMock.mockReturnValue({
      data: {
        success: true,
        request: {
          id: 'REQ', status: 'completed', progress: 100,
          createdAt: '2025-01-01T00:00:00Z',
          audiobook: { title: 'Patient Zero', author: 'Maberry', series: 'Joe Ledger', seriesPart: '1' },
        },
      },
      error: null, isLoading: false,
    });
    const { default: Page } = await import('@/app/requests/[id]/page');
    render(<Page params={paramsFor('REQ')} />);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.getByText(/Joe Ledger · #1/i)).toBeInTheDocument();
  });
});
