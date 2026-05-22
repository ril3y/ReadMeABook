/**
 * Component: Request Activity Route Tests
 * Documentation: documentation/backend/api.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock }));

function buildRequest(query: Record<string, string> = {}, user: any = { id: 'user-1', role: 'user' }) {
  const qs = new URLSearchParams(query).toString();
  return {
    url: `http://localhost/api/requests/REQ/activity${qs ? `?${qs}` : ''}`,
    user,
  } as any;
}

describe('Request activity route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((req: any, handler: any) => handler(req));
  });

  it('returns 404 when request does not exist', async () => {
    prismaMock.request.findFirst.mockResolvedValue(null);
    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest(), { params: Promise.resolve({ id: 'missing' }) });
    const payload = await response.json();
    expect(response.status).toBe(404);
    expect(payload.error).toBe('NotFound');
  });

  it('returns 403 when authenticated user is not the owner', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'someone-else', status: 'downloading',
    });
    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest(), { params: Promise.resolve({ id: 'REQ' }) });
    const payload = await response.json();
    expect(response.status).toBe(403);
    expect(payload.error).toBe('Forbidden');
  });

  it('returns 200 for admin viewing another user\'s request', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'other-user', status: 'completed',
    });
    prismaMock.jobEvent.findMany.mockResolvedValue([]);
    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(
      buildRequest({}, { id: 'admin-1', role: 'admin' }),
      { params: Promise.resolve({ id: 'REQ' }) }
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
  });

  it('returns events newest-first with job metadata', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });
    const ts1 = new Date('2025-01-01T10:00:00Z');
    const ts2 = new Date('2025-01-01T10:05:00Z');
    prismaMock.jobEvent.findMany.mockResolvedValue([
      {
        id: 'evt-2', level: 'info', context: 'MonitorDownload',
        message: '50% complete', metadata: { progress: 50 }, createdAt: ts2,
        job: { id: 'job-1', type: 'monitor_download', status: 'active' },
      },
      {
        id: 'evt-1', level: 'info', context: 'SearchIndexers',
        message: 'Selected best result', metadata: { indexer: 'AudiobookBay' }, createdAt: ts1,
        job: { id: 'job-2', type: 'search_indexers', status: 'completed' },
      },
    ]);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest(), { params: Promise.resolve({ id: 'REQ' }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.events).toHaveLength(2);
    expect(payload.events[0]).toMatchObject({
      id: 'evt-2',
      jobId: 'job-1',
      jobType: 'monitor_download',
      jobStatus: 'active',
      level: 'info',
      context: 'MonitorDownload',
    });
    expect(payload.requestStatus).toBe('downloading');
    expect(payload.nextCursor).toBeNull();
  });

  it('returns empty events and pending status for a fresh request', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'pending',
    });
    prismaMock.jobEvent.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest(), { params: Promise.resolve({ id: 'REQ' }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.events).toEqual([]);
    expect(payload.requestStatus).toBe('pending');
    expect(payload.nextCursor).toBeNull();
  });

  it('detects has-more page when limit+1 rows are returned and emits nextCursor', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });

    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `evt-${i}`,
      level: 'info',
      context: 'X',
      message: `msg ${i}`,
      metadata: null,
      createdAt: new Date(Date.now() - i * 1000),
      job: { id: 'job-1', type: 'monitor_download', status: 'active' },
    }));
    prismaMock.jobEvent.findMany.mockResolvedValue(rows);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest({ limit: '10' }), { params: Promise.resolve({ id: 'REQ' }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.events).toHaveLength(10);
    expect(payload.nextCursor).toBe('evt-9');
  });

  it('applies cursor scoped to this request (compound createdAt + id ordering)', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });
    const cursorDate = new Date('2025-01-01T10:00:00Z');
    prismaMock.jobEvent.findFirst.mockResolvedValue({ id: 'evt-50', createdAt: cursorDate });
    prismaMock.jobEvent.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    await GET(buildRequest({ cursor: 'evt-50' }), { params: Promise.resolve({ id: 'REQ' }) });

    // Cursor must be SCOPED to the request to prevent cross-tenant probing
    expect(prismaMock.jobEvent.findFirst).toHaveBeenCalledWith({
      where: { id: 'evt-50', job: { requestId: 'REQ' } },
      select: { id: true, createdAt: true },
    });
    expect(prismaMock.jobEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job: { requestId: 'REQ' },
          OR: expect.arrayContaining([
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: 'evt-50' } },
          ]),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
    );
  });

  it('returns 400 InvalidCursor when cursor does not exist for this request', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });
    prismaMock.jobEvent.findFirst.mockResolvedValue(null); // cursor not found / from another request

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(
      buildRequest({ cursor: 'evt-from-another-request' }),
      { params: Promise.resolve({ id: 'REQ' }) }
    );
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error).toBe('InvalidCursor');
  });

  it('truncates oversized metadata payloads server-side', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });
    const huge = { dump: 'x'.repeat(10_000) };
    prismaMock.jobEvent.findMany.mockResolvedValue([
      {
        id: 'e1', level: 'info', context: 'X', message: 'big',
        metadata: huge, createdAt: new Date(),
        job: { id: 'job-1', type: 'monitor_download', status: 'active' },
      },
    ]);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    const response = await GET(buildRequest(), { params: Promise.resolve({ id: 'REQ' }) });
    const payload = await response.json();

    expect(payload.events[0].metadataTruncated).toBe(true);
    expect(payload.events[0].metadata).toMatchObject({ _truncated: true });
  });

  it('clamps limit > 200 to 200', async () => {
    prismaMock.request.findFirst.mockResolvedValue({
      id: 'REQ', userId: 'user-1', status: 'downloading',
    });
    prismaMock.jobEvent.findMany.mockResolvedValue([]);

    const { GET } = await import('@/app/api/requests/[id]/activity/route');
    await GET(buildRequest({ limit: '999' }), { params: Promise.resolve({ id: 'REQ' }) });

    expect(prismaMock.jobEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 201 })  // limit + 1
    );
  });
});
