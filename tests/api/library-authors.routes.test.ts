/**
 * Component: Library Authors Route Tests
 * Documentation: documentation/frontend/components.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

let authRequest: any;

const prismaMock = createPrismaMock();
// groupBy isn't in the default prisma model mock — add it.
(prismaMock.plexLibrary as any).groupBy = vi.fn();

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
    url: `http://localhost/api/library/authors${qs ? `?${qs}` : ''}`,
    user: { id: 'user-1', role: 'user' },
  } as any;
}

describe('Library authors route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRequest = buildRequest();
    requireAuthMock.mockImplementation((req: any, handler: any) => handler(req));
  });

  it('returns 400 when no library is configured', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue(null);

    const { GET } = await import('@/app/api/library/authors/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('NoLibraryConfigured');
  });

  it('aggregates and sorts authors alphabetically', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    (prismaMock.plexLibrary as any).groupBy.mockResolvedValue([
      { author: 'Brandon Sanderson', _count: { _all: 14 } },
      { author: 'Andy Weir',         _count: { _all: 3 } },
      { author: 'Jonathan Maberry',  _count: { _all: 15 } },
    ]);

    const { GET } = await import('@/app/api/library/authors/route');
    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(3);
    expect(payload.authors).toEqual([
      { name: 'Andy Weir',         bookCount: 3 },
      { name: 'Brandon Sanderson', bookCount: 14 },
      { name: 'Jonathan Maberry',  bookCount: 15 },
    ]);
  });

  it('paginates the grouped result in-memory', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');

    const groups = Array.from({ length: 100 }, (_, i) => ({
      author: `Author ${String(i).padStart(3, '0')}`,
      _count: { _all: i + 1 },
    }));
    (prismaMock.plexLibrary as any).groupBy.mockResolvedValue(groups);

    const { GET } = await import('@/app/api/library/authors/route');
    const response = await GET(buildRequest({ page: '2', pageSize: '20' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.page).toBe(2);
    expect(payload.pageSize).toBe(20);
    expect(payload.totalCount).toBe(100);
    expect(payload.totalPages).toBe(5);
    expect(payload.hasMore).toBe(true);
    expect(payload.authors).toHaveLength(20);
    expect(payload.authors[0].name).toBe('Author 020');
  });

  it('passes search term into WHERE author contains clause', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('lib-1');
    (prismaMock.plexLibrary as any).groupBy.mockResolvedValue([]);

    const { GET } = await import('@/app/api/library/authors/route');
    await GET(buildRequest({ search: 'sander' }));

    expect((prismaMock.plexLibrary as any).groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          plexLibraryId: 'lib-1',
          author: expect.objectContaining({ contains: 'sander', mode: 'insensitive' }),
        }),
      })
    );
  });
});
