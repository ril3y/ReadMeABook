/**
 * Component: Detect Stalled Downloads Processor Tests
 * Documentation: documentation/backend/services/scheduler.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const configMock = vi.hoisted(() => ({ get: vi.fn() }));
const jobQueueMock = vi.hoisted(() => ({
  addSearchJob: vi.fn().mockResolvedValue('search-job-id'),
  addSearchEbookJob: vi.fn().mockResolvedValue('search-ebook-job-id'),
}));
const blocklistMock = vi.hoisted(() => ({
  addAutoBlock: vi.fn().mockResolvedValue({ blocked: { id: 'block-1' }, wasNew: true }),
}));
const downloadClientManagerMock = vi.hoisted(() => ({
  getClientServiceForProtocol: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/services/blocklist.service', () => ({
  addAutoBlock: blocklistMock.addAutoBlock,
}));

vi.mock('@/lib/services/download-client-manager.service', () => ({
  getDownloadClientManager: () => downloadClientManagerMock,
}));

function makeStalledRequest(overrides: Record<string, any> = {}) {
  const startedAt = overrides.startedAt ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  return {
    id: 'req-1',
    type: 'audiobook',
    status: 'downloading',
    progress: 23,
    audiobook: {
      id: 'ab-1',
      title: 'The Test Book',
      author: 'Test Author',
      audibleAsin: 'B0TESTASIN',
    },
    downloadHistory: [
      {
        id: 'dh-1',
        torrentName: 'The.Test.Book.2026.MP3-FOO',
        torrentHash: 'abc123',
        nzbId: null,
        indexerName: 'IndexerA',
        indexerId: 7,
        downloadClient: 'qbittorrent',
        downloadClientId: 'abc123',
        startedAt,
      },
    ],
    ...overrides,
  };
}

describe('processDetectStalledDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.get.mockResolvedValue('7');
  });

  it('returns early when no stalled downloads are found', async () => {
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-1' });

    expect(result.success).toBe(true);
    expect(result.swapped).toBe(0);
    expect(prismaMock.request.update).not.toHaveBeenCalled();
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
    expect(blocklistMock.addAutoBlock).not.toHaveBeenCalled();
  });

  it('uses 7-day default when config value is missing or invalid', async () => {
    configMock.get.mockResolvedValue(null);
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-2' });

    expect(result.timeoutDays).toBe(7);
  });

  it('clamps absurdly large timeout values', async () => {
    configMock.get.mockResolvedValue('99999');
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-3' });

    expect(result.timeoutDays).toBe(365);
  });

  it('swaps a stalled audiobook: deletes torrent, blocks release, resets request, queues search', async () => {
    const deleteDownloadMock = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue({
      deleteDownload: deleteDownloadMock,
    });
    prismaMock.request.findMany.mockResolvedValue([makeStalledRequest()]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-4' });

    expect(result.success).toBe(true);
    expect(result.swapped).toBe(1);
    expect(result.failed).toBe(0);

    // 1. Torrent deleted with files
    expect(deleteDownloadMock).toHaveBeenCalledWith('abc123', true);

    // 2. Release blocked with stall-source + reason prefix
    expect(blocklistMock.addAutoBlock).toHaveBeenCalledTimes(1);
    const blockCall = blocklistMock.addAutoBlock.mock.calls[0][0];
    expect(blockCall.requestId).toBe('req-1');
    expect(blockCall.releaseName).toBe('The.Test.Book.2026.MP3-FOO');
    expect(blockCall.releaseHash).toBe('abc123');
    expect(blockCall.source).toBe('download_fail');
    expect(blockCall.reason).toContain('Stalled timeout');
    expect(blockCall.indexerName).toBe('IndexerA');

    // 3. DH row marked failed
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dh-1' },
        data: expect.objectContaining({ downloadStatus: 'failed' }),
      })
    );

    // 4. Request flipped to awaiting_search with progress reset
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req-1' },
        data: expect.objectContaining({
          status: 'awaiting_search',
          progress: 0,
        }),
      })
    );

    // 5. Fresh search queued for audiobook (not ebook)
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ id: 'ab-1', title: 'The Test Book' })
    );
    expect(jobQueueMock.addSearchEbookJob).not.toHaveBeenCalled();
  });

  it('routes ebook stalls to addSearchEbookJob', async () => {
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue({
      deleteDownload: vi.fn().mockResolvedValue(undefined),
    });
    prismaMock.request.findMany.mockResolvedValue([
      makeStalledRequest({ id: 'req-eb', type: 'ebook' }),
    ]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    await processDetectStalledDownloads({ jobId: 'job-5' });

    expect(jobQueueMock.addSearchEbookJob).toHaveBeenCalledWith(
      'req-eb',
      expect.objectContaining({ id: 'ab-1' })
    );
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
  });

  it('continues the swap when the download-client delete fails', async () => {
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue({
      deleteDownload: vi.fn().mockRejectedValue(new Error('client unreachable')),
    });
    prismaMock.request.findMany.mockResolvedValue([makeStalledRequest()]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-6' });

    // Delete failure must NOT block the rest of the swap
    expect(result.swapped).toBe(1);
    expect(blocklistMock.addAutoBlock).toHaveBeenCalled();
    expect(prismaMock.request.update).toHaveBeenCalled();
    expect(jobQueueMock.addSearchJob).toHaveBeenCalled();
  });

  it('caps the per-run swap volume at 50 requests', async () => {
    // The processor passes `take: 50` to the DB query. Verify the query argument
    // (we can't easily produce 50 distinct fixtures here, so we assert on the
    // query options instead — same approach as cleanup-seeded-torrents).
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    await processDetectStalledDownloads({ jobId: 'job-7' });

    expect(prismaMock.request.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });

  it('queries only currently-downloading requests with progress < 100 past the cutoff', async () => {
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    await processDetectStalledDownloads({ jobId: 'job-8' });

    const call = prismaMock.request.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('downloading');
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.progress).toEqual({ lt: 100 });
    expect(call.where.downloadHistory.some.selected).toBe(true);
    expect(call.where.downloadHistory.some.startedAt.lt).toBeInstanceOf(Date);
  });
});
