/**
 * Component: Library Series Route Tests
 * Documentation: documentation/frontend/components.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const configMock = vi.hoisted(() => ({
  getBackendMode: vi.fn(),
  get: vi.fn(),
  getPlexConfig: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));

function buildRequest(query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return {
    url: `http://localhost/api/library/series${qs ? `?${qs}` : ''}`,
    user: { id: 'user-1', role: 'user' },
  } as any;
}

describe('Library series route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((req: any, handler: any) => handler(req));
  });

  it('returns 400 when no library is configured', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue(null);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('NoLibraryConfigured');
  });

  it('returns empty series list when library has no ASIN-bearing books', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(0);
    expect(payload.series).toEqual([]);
  });

  it('aggregates owned books into series with bookCount', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([
      { asin: 'ASIN1' }, { asin: 'ASIN2' }, { asin: 'ASIN3' }, { asin: 'ASIN4' },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { audibleAsin: 'ASIN1', series: 'Joe Ledger', seriesAsin: 'SER1', coverArtUrl: 'a.jpg' },
      { audibleAsin: 'ASIN2', series: 'Joe Ledger', seriesAsin: 'SER1', coverArtUrl: 'b.jpg' },
      { audibleAsin: 'ASIN3', series: 'Joe Ledger', seriesAsin: 'SER1', coverArtUrl: 'c.jpg' },
      { audibleAsin: 'ASIN4', series: 'Mistborn', seriesAsin: 'SER2', coverArtUrl: 'd.jpg' },
    ]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(2);
    expect(payload.series).toEqual([
      { title: 'Joe Ledger', bookCount: 3, asin: 'SER1', coverArtUrl: 'a.jpg' },
      { title: 'Mistborn',  bookCount: 1, asin: 'SER2', coverArtUrl: 'd.jpg' },
    ]);
  });

  it('ignores books without series data', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([
      { asin: 'ASIN1' }, { asin: 'ASIN2' },
    ]);
    // findMany already filters by series:{not:null}, but verify empty result handles gracefully
    prismaMock.audiobook.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(0);
  });

  it('search filter is case-insensitive substring match', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([{ asin: 'A' }, { asin: 'B' }]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { audibleAsin: 'A', series: 'Joe Ledger', seriesAsin: null, coverArtUrl: null },
      { audibleAsin: 'B', series: 'Mistborn',  seriesAsin: null, coverArtUrl: null },
    ]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest({ search: 'joe' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(1);
    expect(payload.series[0].title).toBe('Joe Ledger');
  });
});
