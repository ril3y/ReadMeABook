/**
 * Component: Request Activity Timeline Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequestActivityTimeline } from '@/components/requests/RequestActivityTimeline';
import type { ActivityEvent } from '@/lib/hooks/useRequestActivity';

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    level: 'info',
    context: 'Worker',
    message: 'something',
    metadata: null,
    jobId: 'job-A',
    jobType: 'search_indexers',
    jobStatus: 'completed',
    ...over,
  };
}

describe('RequestActivityTimeline', () => {
  it('renders skeleton placeholders while loading with no events yet', () => {
    const { container } = render(
      <RequestActivityTimeline events={[]} isLoading={true} requestStatus="pending" />
    );
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an empty state when there are no events and request is pending', () => {
    render(
      <RequestActivityTimeline events={[]} isLoading={false} requestStatus="pending" />
    );
    expect(screen.getByText(/No activity recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Queued/i)).toBeInTheDocument();
  });

  it('shows the post-pending empty copy when request is no longer pending', () => {
    render(
      <RequestActivityTimeline events={[]} isLoading={false} requestStatus="failed" />
    );
    expect(screen.getByText(/No activity recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText(/may be too old, or its jobs have been purged/i)).toBeInTheDocument();
  });

  it('groups consecutive events from the same job and renders the human job-type label', () => {
    const events = [
      ev({ id: 'e1', jobId: 'job-A', jobType: 'search_indexers', message: 'Searching' }),
      ev({ id: 'e2', jobId: 'job-A', jobType: 'search_indexers', message: 'Found 3' }),
      ev({ id: 'e3', jobId: 'job-B', jobType: 'monitor_download', message: 'Downloading',  jobStatus: 'active' }),
    ];
    render(
      <RequestActivityTimeline events={events} isLoading={false} requestStatus="downloading" />
    );
    expect(screen.getByText('Search Indexers')).toBeInTheDocument();
    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByText('Searching')).toBeInTheDocument();
    expect(screen.getByText('Found 3')).toBeInTheDocument();
    expect(screen.getByText('Downloading')).toBeInTheDocument();
  });

  it('starts a new job group when jobId changes even if jobType repeats', () => {
    const events = [
      ev({ id: 'e1', jobId: 'job-A', jobType: 'search_indexers', message: 'A done' }),
      ev({ id: 'e2', jobId: 'job-B', jobType: 'search_indexers', message: 'B started' }),
    ];
    render(<RequestActivityTimeline events={events} isLoading={false} />);
    // Two separate job-type labels are rendered (one per group)
    const labels = screen.getAllByText('Search Indexers');
    expect(labels.length).toBe(2);
  });

  it('renders an expandable metadata block when metadata is non-empty', () => {
    const events = [
      ev({ id: 'e1', message: 'hi', metadata: { progress: 42, indexer: 'AudiobookBay' } }),
    ];
    render(<RequestActivityTimeline events={events} isLoading={false} />);
    const toggle = screen.getByText('show details');
    expect(toggle).toBeInTheDocument();
    // Open the <details>
    fireEvent.click(toggle);
    expect(screen.getByText(/AudiobookBay/)).toBeInTheDocument();
    expect(screen.getByText(/"progress": 42/)).toBeInTheDocument();
  });

  it('does NOT render the metadata block when metadata is null or empty object', () => {
    const events = [
      ev({ id: 'e1', message: 'no meta', metadata: null }),
      ev({ id: 'e2', message: 'empty meta', metadata: {} }),
    ];
    render(<RequestActivityTimeline events={events} isLoading={false} />);
    expect(screen.queryByText('show details')).not.toBeInTheDocument();
  });

  it('renders a level-specific colour cue for warn and error', () => {
    const events = [
      ev({ id: 'e1', level: 'warn',  message: 'warn line', jobId: 'job-W', jobType: 'organize_files' }),
      ev({ id: 'e2', level: 'error', message: 'error line', jobId: 'job-E', jobType: 'organize_files' }),
    ];
    const { container } = render(<RequestActivityTimeline events={events} isLoading={false} />);
    expect(container.querySelector('.bg-amber-500')).not.toBeNull();
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
  });

  it('renders the short jobId prefix in the job header', () => {
    const events = [
      ev({ id: 'e1', jobId: 'abcdef0123456789', message: 'one' }),
    ];
    render(<RequestActivityTimeline events={events} isLoading={false} />);
    expect(screen.getByText('abcdef01')).toBeInTheDocument();
  });
});
