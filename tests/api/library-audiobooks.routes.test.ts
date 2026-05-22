/**
 * Component: Library Audiobooks Route Tests
 * Documentation: documentation/frontend/components.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

let authRequest: any;

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
    url: `http://localhost/api/library/audiobooks${qs ? `?${qs}` : ''}`,
    user: { id: 'user-1', role: 'user' },
  } as any;
}

describe('Library audiobooks route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRequest = buildRequest();
    requireAuthMock.mockImplementation((req: any, handler: any) => handler(req));
  });

  it('returns 400 when Audiobookshelf library ID is missing', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue(null);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('NoLibraryConfigured');
  });

  it('returns 400 when Plex library ID is missing', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({ libraryId: null });

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('NoLibraryConfigured');
  });

  it('returns paginated owned audiobooks with isAvailable=true', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([
      {
        id: 'plex-1',
        title: 'Patient Zero',
        author: 'Jonathan Maberry',
        narrator: 'Ray Porter',
        summary: 'Joe Ledger #1',
        duration: BigInt(50000000),
        year: 2009,
        asin: 'ASIN1',
        isbn: null,
        plexGuid: 'guid-1',
        thumbUrl: null,
        cachedLibraryCoverPath: '/cache/library/cover1.jpg',
        addedAt: new Date('2025-01-01'),
      },
    ]);
    prismaMock.plexLibrary.count.mockResolvedValue(1);
    prismaMock.audibleCache.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest({ page: '1', pageSize: '10' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.totalCount).toBe(1);
    expect(payload.audiobooks).toHaveLength(1);
    expect(payload.audiobooks[0]).toMatchObject({
      asin: 'ASIN1',
      title: 'Patient Zero',
      author: 'Jonathan Maberry',
      isAvailable: true,
      coverArtUrl: '/api/cache/library/cover1.jpg',
    });
  });

  it('falls back to AudibleCache cover when library cache is missing', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([
      {
        id: 'plex-2',
        title: 'Audible Cover',
        author: 'Author B',
        narrator: null,
        summary: null,
        duration: null,
        year: null,
        asin: 'ASIN2',
        isbn: null,
        plexGuid: null,
        thumbUrl: null,
        cachedLibraryCoverPath: null,
        addedAt: null,
      },
    ]);
    prismaMock.plexLibrary.count.mockResolvedValue(1);
    prismaMock.audibleCache.findMany.mockResolvedValue([
      { asin: 'ASIN2', coverArtUrl: 'http://audible/cover2.jpg', cachedCoverPath: null },
    ]);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.audiobooks[0].coverArtUrl).toBe('http://audible/cover2.jpg');
  });

  it('uses synthetic key when row has no ASIN', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    prismaMock.plexLibrary.findMany.mockResolvedValue([
      {
        id: 'plex-3',
        title: 'No ASIN',
        author: 'Anon',
        narrator: null,
        summary: null,
        duration: null,
        year: null,
        asin: null,
        isbn: null,
        plexGuid: null,
        thumbUrl: null,
        cachedLibraryCoverPath: null,
        addedAt: null,
      },
    ]);
    prismaMock.plexLibrary.count.mockResolvedValue(1);
    prismaMock.audibleCache.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.audiobooks[0].asin).toBe('lib_plex-3');
    expect(payload.audiobooks[0].isAvailable).toBe(true);
  });

  it('clamps pageSize > 100 to 100', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.plexLibrary.count.mockResolvedValue(0);
    prismaMock.audibleCache.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    const response = await GET(buildRequest({ pageSize: '500' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageSize).toBe(100);
  });

  it('passes search term into WHERE OR clause across title/author/narrator', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.plexLibrary.count.mockResolvedValue(0);
    prismaMock.audibleCache.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/audiobooks/route');
    await GET(buildRequest({ search: 'sanderson' }));

    expect(prismaMock.plexLibrary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          plexLibraryId: 'lib-1',
          OR: expect.arrayContaining([
            expect.objectContaining({ title: { contains: 'sanderson', mode: 'insensitive' } }),
            expect.objectContaining({ author: { contains: 'sanderson', mode: 'insensitive' } }),
          ]),
        }),
      })
    );
  });
});
