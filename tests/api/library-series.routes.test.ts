/**
 * Component: Library Series Route Tests
 * Documentation: documentation/frontend/components.md
 *
 * Exercises /api/library/series end-to-end: aggregation, ASIN enrichment
 * from the audiobooks lookup, and the new totalBooks denominator sourced
 * from the series_catalog cache.
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

const seriesCatalogMock = vi.hoisted(() => ({
  getSeriesCatalogByAsins: vi.fn(),
  pickStaleAsins: vi.fn(),
  refreshSeriesCatalogInBackground: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));
vi.mock('@/lib/services/series-catalog.service', () => seriesCatalogMock);

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
    // Default catalog: empty cache, no stale refreshes.
    seriesCatalogMock.getSeriesCatalogByAsins.mockResolvedValue(new Map());
    seriesCatalogMock.pickStaleAsins.mockReturnValue([]);
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

  it('returns empty series list when no series exist in the library', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');
    prismaMock.plexLibrary.groupBy.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(0);
    expect(payload.series).toEqual([]);
    // No ASINs means no catalog lookup should happen
    expect(seriesCatalogMock.getSeriesCatalogByAsins).not.toHaveBeenCalled();
  });

  it('aggregates by series and enriches with ASIN from audiobooks', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.groupBy.mockResolvedValue([
      { series: 'Joe Ledger', _count: { _all: 3 } },
      { series: 'Mistborn',  _count: { _all: 1 } },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { series: 'Joe Ledger', seriesAsin: 'SER1ABCDE0', coverArtUrl: 'a.jpg' },
      { series: 'Mistborn',   seriesAsin: 'SER2ABCDE0', coverArtUrl: 'd.jpg' },
    ]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(2);
    expect(payload.series).toEqual([
      { title: 'Joe Ledger', bookCount: 3, asin: 'SER1ABCDE0', coverArtUrl: 'a.jpg' },
      { title: 'Mistborn',   bookCount: 1, asin: 'SER2ABCDE0', coverArtUrl: 'd.jpg' },
    ]);
  });

  it('attaches totalBooks from the series_catalog cache when present', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.groupBy.mockResolvedValue([
      { series: 'Joe Ledger', _count: { _all: 3 } },
      { series: 'Mistborn',  _count: { _all: 1 } },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { series: 'Joe Ledger', seriesAsin: 'SER1ABCDE0', coverArtUrl: 'a.jpg' },
      { series: 'Mistborn',   seriesAsin: 'SER2ABCDE0', coverArtUrl: 'd.jpg' },
    ]);

    seriesCatalogMock.getSeriesCatalogByAsins.mockResolvedValue(new Map([
      ['ser1abcde0', { seriesAsin: 'SER1ABCDE0', title: 'Joe Ledger', totalBooks: 12, coverArtUrl: null, audibleUrl: null, lastSyncedAt: new Date() }],
      // Mistborn intentionally absent — falls back to no denominator
    ]));

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    const joe = payload.series.find((s: any) => s.title === 'Joe Ledger');
    const mist = payload.series.find((s: any) => s.title === 'Mistborn');
    expect(joe.totalBooks).toBe(12);
    expect(mist.totalBooks).toBeUndefined();
  });

  it('triggers background refresh for stale or missing catalog entries only', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.groupBy.mockResolvedValue([
      { series: 'Joe Ledger', _count: { _all: 3 } },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { series: 'Joe Ledger', seriesAsin: 'SER1ABCDE0', coverArtUrl: 'a.jpg' },
    ]);

    seriesCatalogMock.pickStaleAsins.mockReturnValue(['SER1ABCDE0']);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(200);
    expect(seriesCatalogMock.refreshSeriesCatalogInBackground).toHaveBeenCalledWith(['SER1ABCDE0']);
  });

  it('does not call refresh when nothing is stale', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.groupBy.mockResolvedValue([
      { series: 'Joe Ledger', _count: { _all: 3 } },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([
      { series: 'Joe Ledger', seriesAsin: 'SER1ABCDE0', coverArtUrl: 'a.jpg' },
    ]);

    seriesCatalogMock.pickStaleAsins.mockReturnValue([]);

    const { GET } = await import('@/app/api/library/series/route');
    await GET(buildRequest());

    expect(seriesCatalogMock.refreshSeriesCatalogInBackground).not.toHaveBeenCalled();
  });

  it('search filter is case-insensitive substring match', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.groupBy.mockResolvedValue([
      { series: 'Joe Ledger', _count: { _all: 3 } },
      { series: 'Mistborn',  _count: { _all: 1 } },
    ]);
    prismaMock.audiobook.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/series/route');
    const response = await GET(buildRequest({ search: 'joe' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(1);
    expect(payload.series[0].title).toBe('Joe Ledger');
  });
});
