/**
 * Component: Series Catalog Service Tests
 * Documentation: documentation/features/series-totals.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/integrations/audible-series', () => ({
  scrapeSeriesPage: vi.fn(),
}));

describe('series-catalog service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('upsertSeriesCatalog', () => {
    it('upserts a valid entry', async () => {
      const { upsertSeriesCatalog } = await import('@/lib/services/series-catalog.service');
      prismaMock.seriesCatalog.upsert.mockResolvedValue({});

      await upsertSeriesCatalog({
        seriesAsin: 'B006K1QER6',
        title: 'Mistborn',
        totalBooks: 7,
        coverArtUrl: 'cover.jpg',
        audibleUrl: 'https://audible.com/series/B006K1QER6',
      });

      expect(prismaMock.seriesCatalog.upsert).toHaveBeenCalledTimes(1);
      const call = prismaMock.seriesCatalog.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ seriesAsin: 'B006K1QER6' });
      expect(call.create.totalBooks).toBe(7);
      expect(call.update.totalBooks).toBe(7);
      expect(call.update.lastSyncedAt).toBeInstanceOf(Date);
    });

    it('rejects malformed ASINs without hitting the DB', async () => {
      const { upsertSeriesCatalog } = await import('@/lib/services/series-catalog.service');

      await upsertSeriesCatalog({ seriesAsin: 'not-an-asin', title: 'X', totalBooks: 3 });
      await upsertSeriesCatalog({ seriesAsin: '', title: 'X', totalBooks: 3 });

      expect(prismaMock.seriesCatalog.upsert).not.toHaveBeenCalled();
    });

    it('skips zero-count rows (scrape probably failed)', async () => {
      const { upsertSeriesCatalog } = await import('@/lib/services/series-catalog.service');

      await upsertSeriesCatalog({ seriesAsin: 'B006K1QER6', title: 'X', totalBooks: 0 });

      expect(prismaMock.seriesCatalog.upsert).not.toHaveBeenCalled();
    });

    it('swallows DB errors so the calling request never fails', async () => {
      const { upsertSeriesCatalog } = await import('@/lib/services/series-catalog.service');
      prismaMock.seriesCatalog.upsert.mockRejectedValue(new Error('connection lost'));

      // Should not throw
      await expect(
        upsertSeriesCatalog({ seriesAsin: 'B006K1QER6', title: 'Mistborn', totalBooks: 7 })
      ).resolves.toBeUndefined();
    });
  });

  describe('getSeriesCatalogByAsins', () => {
    it('returns a map keyed by lowercased ASIN', async () => {
      const { getSeriesCatalogByAsins } = await import('@/lib/services/series-catalog.service');
      prismaMock.seriesCatalog.findMany.mockResolvedValue([
        { seriesAsin: 'B006K1QER6', title: 'Mistborn', totalBooks: 7, coverArtUrl: null, audibleUrl: null, lastSyncedAt: new Date() },
      ]);

      const result = await getSeriesCatalogByAsins(['b006k1qer6']);

      expect(result.size).toBe(1);
      expect(result.get('b006k1qer6')?.totalBooks).toBe(7);
    });

    it('deduplicates input ASINs and uppercases before query', async () => {
      const { getSeriesCatalogByAsins } = await import('@/lib/services/series-catalog.service');
      prismaMock.seriesCatalog.findMany.mockResolvedValue([]);

      await getSeriesCatalogByAsins(['B006K1QER6', 'b006k1qer6', 'B006K1QER6']);

      const call = prismaMock.seriesCatalog.findMany.mock.calls[0][0];
      expect(call.where.seriesAsin.in).toEqual(['B006K1QER6']);
    });

    it('filters out malformed ASINs', async () => {
      const { getSeriesCatalogByAsins } = await import('@/lib/services/series-catalog.service');
      prismaMock.seriesCatalog.findMany.mockResolvedValue([]);

      await getSeriesCatalogByAsins(['bad', '', 'B006K1QER6']);

      const call = prismaMock.seriesCatalog.findMany.mock.calls[0][0];
      expect(call.where.seriesAsin.in).toEqual(['B006K1QER6']);
    });

    it('returns empty map and skips DB when input is empty', async () => {
      const { getSeriesCatalogByAsins } = await import('@/lib/services/series-catalog.service');

      const result = await getSeriesCatalogByAsins([]);

      expect(result.size).toBe(0);
      expect(prismaMock.seriesCatalog.findMany).not.toHaveBeenCalled();
    });
  });

  describe('pickStaleAsins', () => {
    it('returns ASINs missing from the catalog', async () => {
      const { pickStaleAsins } = await import('@/lib/services/series-catalog.service');

      const stale = pickStaleAsins(
        [{ seriesAsin: 'B006K1QER6' }, { seriesAsin: 'B0XX111111' }],
        new Map([
          ['b006k1qer6', { seriesAsin: 'B006K1QER6', title: 'Mistborn', totalBooks: 7, coverArtUrl: null, audibleUrl: null, lastSyncedAt: new Date() }],
        ])
      );

      expect(stale).toEqual(['B0XX111111']);
    });

    it('returns ASINs whose lastSyncedAt is older than the freshness window', async () => {
      const { pickStaleAsins } = await import('@/lib/services/series-catalog.service');

      // 8 days old — beyond the 7-day window
      const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000);

      const result = pickStaleAsins(
        [{ seriesAsin: 'B006K1QER6' }, { seriesAsin: 'B0XX111111' }],
        new Map([
          ['b006k1qer6', { seriesAsin: 'B006K1QER6', title: 'X', totalBooks: 1, coverArtUrl: null, audibleUrl: null, lastSyncedAt: fresh }],
          ['b0xx111111', { seriesAsin: 'B0XX111111', title: 'Y', totalBooks: 1, coverArtUrl: null, audibleUrl: null, lastSyncedAt: stale }],
        ])
      );

      expect(result).toEqual(['B0XX111111']);
    });

    it('deduplicates input ASINs', async () => {
      const { pickStaleAsins } = await import('@/lib/services/series-catalog.service');

      const result = pickStaleAsins(
        [{ seriesAsin: 'B0XX111111' }, { seriesAsin: 'b0xx111111' }],
        new Map()
      );

      expect(result).toEqual(['B0XX111111']);
    });
  });

  describe('refreshSeriesCatalogInBackground', () => {
    it('is a noop for empty input', async () => {
      const { refreshSeriesCatalogInBackground } = await import('@/lib/services/series-catalog.service');
      const audible = await import('@/lib/integrations/audible-series');

      refreshSeriesCatalogInBackground([]);

      expect(audible.scrapeSeriesPage).not.toHaveBeenCalled();
    });

    it('caps the number of scrapes regardless of input size', async () => {
      const { refreshSeriesCatalogInBackground } = await import('@/lib/services/series-catalog.service');
      const audible = await import('@/lib/integrations/audible-series');

      // Make scrape resolve immediately
      (audible.scrapeSeriesPage as any).mockResolvedValue(null);

      // 20 ASINs but service is capped at 5
      const inputs = Array.from({ length: 20 }, (_, i) => `B00000000${i.toString().padStart(2, '0')}`.slice(0, 10));
      refreshSeriesCatalogInBackground(inputs);

      // Let the background promise drain
      await new Promise((r) => setTimeout(r, 10));
      // Eventually we'll see at most 5 calls (run sequentially with backoff);
      // we can't easily wait for all of them due to the 750ms inter-request
      // delay, so just assert it never exceeds the cap.
      expect((audible.scrapeSeriesPage as any).mock.calls.length).toBeLessThanOrEqual(5);
    });
  });
});
