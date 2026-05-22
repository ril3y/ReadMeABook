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
    // Default config: 7-day timeout, swap below 50%, global threshold 3.
    // Individual tests can override with mockImplementation.
    configMock.get.mockImplementation((key: string) => {
      if (key === 'automation.stall_timeout_days') return Promise.resolve('7');
      if (key === 'automation.stall_swap_max_progress') return Promise.resolve('50');
      if (key === 'automation.global_block_threshold') return Promise.resolve('3');
      return Promise.resolve(null);
    });
    // Stall counter defaults to 1 (just this stall, no previous ones) so the
    // global-threshold path is NOT taken unless a test overrides this.
    prismaMock.blockedRelease.count.mockResolvedValue(1);
    prismaMock.blockedRelease.updateMany.mockResolvedValue({ count: 0 });
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

  it('queries only currently-downloading requests with progress below maxProgress past the cutoff', async () => {
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    await processDetectStalledDownloads({ jobId: 'job-8' });

    const call = prismaMock.request.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('downloading');
    expect(call.where.deletedAt).toBeNull();
    // Default maxProgress is 50 — anything 50%+ is spared
    expect(call.where.progress).toEqual({ lt: 50 });
    expect(call.where.downloadHistory.some.selected).toBe(true);
    expect(call.where.downloadHistory.some.startedAt.lt).toBeInstanceOf(Date);
  });

  it('honors a custom maxProgress setting (e.g. 95% means swap almost anything)', async () => {
    configMock.get.mockImplementation((key: string) => {
      if (key === 'automation.stall_timeout_days') return Promise.resolve('7');
      if (key === 'automation.stall_swap_max_progress') return Promise.resolve('95');
      if (key === 'automation.global_block_threshold') return Promise.resolve('3');
      return Promise.resolve(null);
    });
    prismaMock.request.findMany.mockResolvedValue([]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-9' });

    expect(result.maxProgress).toBe(95);
    expect(prismaMock.request.findMany.mock.calls[0][0].where.progress).toEqual({ lt: 95 });
  });

  it('promotes a release to GLOBAL block when stall count crosses the threshold', async () => {
    // 3 prior stalls + this one = 3 total → threshold met
    prismaMock.blockedRelease.count.mockResolvedValue(3);
    prismaMock.blockedRelease.updateMany.mockResolvedValue({ count: 3 });
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue({
      deleteDownload: vi.fn().mockResolvedValue(undefined),
    });
    prismaMock.request.findMany.mockResolvedValue([makeStalledRequest()]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-10' });

    expect(result.promotedToGlobal).toBe(3);
    expect(prismaMock.blockedRelease.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'download_fail',
          global: false,
        }),
        data: { global: true },
      })
    );
  });

  it('does NOT promote to global when stall count is below the threshold', async () => {
    prismaMock.blockedRelease.count.mockResolvedValue(2); // < threshold of 3
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue({
      deleteDownload: vi.fn().mockResolvedValue(undefined),
    });
    prismaMock.request.findMany.mockResolvedValue([makeStalledRequest()]);

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'job-11' });

    expect(result.promotedToGlobal).toBe(0);
    expect(prismaMock.blockedRelease.updateMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Stage 2 — qBT-direct orphan + stale scan
  //
  // These tests bypass Stage 1 (no `downloading` requests in the DB) so the
  // processor falls through to Stage 2 and operates on the torrents returned
  // by `listDownloads()`.
  // ---------------------------------------------------------------------------

  function makeStaleTorrent(overrides: Record<string, any> = {}) {
    return {
      id: 'hashlowercase1',
      name: 'A.Test.Release-GROUP',
      size: 1024,
      bytesDownloaded: 256,
      progress: 0.25,
      status: 'downloading',
      downloadSpeed: 0, // not progressing
      eta: 0,
      category: 'readmeabook',
      addedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 14d ago
      ...overrides,
    };
  }

  function makeStaleClientMock(torrents: any[], deleteFn?: any) {
    return {
      listDownloads: vi.fn().mockResolvedValue(torrents),
      deleteDownload: deleteFn ?? vi.fn().mockResolvedValue(undefined),
    };
  }

  it('Stage 2: deletes orphan torrents (no matching DH row)', async () => {
    prismaMock.request.findMany.mockResolvedValue([]); // skip Stage 1
    prismaMock.downloadHistory.findMany.mockResolvedValue([]); // no DH match → orphan
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      makeStaleClientMock([makeStaleTorrent()], deleteFn)
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'stage2-1' });

    expect(result.orphansDeleted).toBe(1);
    expect(result.staleLinkedDeleted).toBe(0);
    // Orphans get the deleteWithFiles=true call
    expect(deleteFn).toHaveBeenCalledWith('hashlowercase1', true);
    // No block/search since there's no Request behind the orphan
    expect(blocklistMock.addAutoBlock).not.toHaveBeenCalled();
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
  });

  it('Stage 2: stale-linked with Request.status=available deletes torrent but does NOT re-search', async () => {
    prismaMock.request.findMany.mockResolvedValue([]); // skip Stage 1
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      {
        id: 'dh-stale-1',
        torrentHash: 'hashlowercase1',
        torrentName: 'A.Test.Release-GROUP',
        nzbId: null,
        indexerName: 'IndexerA',
        indexerId: 7,
        request: {
          id: 'req-stale-1',
          status: 'available', // already in library
          type: 'audiobook',
          deletedAt: null,
          audiobook: { id: 'ab-1', title: 'X', author: 'Y', audibleAsin: 'Z' },
        },
      },
    ]);
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      makeStaleClientMock([makeStaleTorrent()], deleteFn)
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'stage2-2' });

    expect(result.staleLinkedDeleted).toBe(1);
    expect(deleteFn).toHaveBeenCalledWith('hashlowercase1', true);
    // No block / no search — the book is already owned
    expect(blocklistMock.addAutoBlock).not.toHaveBeenCalled();
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
  });

  it('Stage 2: stale-linked with Request.status=awaiting_search blocks release + queues fresh search + deletes torrent', async () => {
    prismaMock.request.findMany.mockResolvedValue([]); // skip Stage 1
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      {
        id: 'dh-stale-2',
        torrentHash: 'hashlowercase1',
        torrentName: 'Another.Release-FOO',
        nzbId: null,
        indexerName: 'IndexerA',
        indexerId: 7,
        request: {
          id: 'req-stale-2',
          status: 'awaiting_search',
          type: 'audiobook',
          deletedAt: null,
          audiobook: { id: 'ab-2', title: 'Title2', author: 'Author2', audibleAsin: 'ASIN2' },
        },
      },
    ]);
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      makeStaleClientMock([makeStaleTorrent()], deleteFn)
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'stage2-3' });

    expect(result.staleLinkedDeleted).toBe(1);
    expect(deleteFn).toHaveBeenCalledWith('hashlowercase1', true);
    // Block was written for this request
    expect(blocklistMock.addAutoBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-stale-2',
        releaseName: 'Another.Release-FOO',
        source: 'download_fail',
      })
    );
    // Fresh search queued (audiobook path, not ebook)
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledWith(
      'req-stale-2',
      expect.objectContaining({ id: 'ab-2' })
    );
    expect(jobQueueMock.addSearchEbookJob).not.toHaveBeenCalled();
  });

  it('Stage 2: SKIPS torrents whose Request is in downloading (Stage 1 territory)', async () => {
    prismaMock.request.findMany.mockResolvedValue([]); // Stage 1's own query is empty
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      {
        id: 'dh-active-1',
        torrentHash: 'hashlowercase1',
        torrentName: 'Active.Release',
        nzbId: null,
        indexerName: null,
        indexerId: null,
        request: {
          id: 'req-active',
          status: 'downloading', // Stage 1's responsibility
          type: 'audiobook',
          deletedAt: null,
          audiobook: { id: 'ab-3', title: 'T', author: 'A', audibleAsin: null },
        },
      },
    ]);
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      makeStaleClientMock([makeStaleTorrent()], deleteFn)
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'stage2-4' });

    // No deletion: ownership belongs to Stage 1 in this pass
    expect(result.orphansDeleted).toBe(0);
    expect(result.staleLinkedDeleted).toBe(0);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('Stage 2: lowercases the qBT hash when looking up DH rows (case-mismatch defense)', async () => {
    prismaMock.request.findMany.mockResolvedValue([]);
    prismaMock.downloadHistory.findMany.mockResolvedValue([]);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      // qBT sometimes returns uppercase hex; the processor must lowercase it
      // before querying the DB or it'll miss DH rows persisted in lowercase.
      makeStaleClientMock([makeStaleTorrent({ id: 'AABBCCDD11223344' })])
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    await processDetectStalledDownloads({ jobId: 'stage2-5' });

    expect(prismaMock.downloadHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { torrentHash: { in: ['aabbccdd11223344'] } },
      })
    );
  });

  it('Stage 2: still deletes the torrent if block-and-research throws (delete-in-finally semantics)', async () => {
    prismaMock.request.findMany.mockResolvedValue([]);
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      {
        id: 'dh-stale-3',
        torrentHash: 'hashlowercase1',
        torrentName: 'Throw.Release',
        nzbId: null,
        indexerName: 'IndexerA',
        indexerId: 7,
        request: {
          id: 'req-stale-3',
          status: 'awaiting_search',
          type: 'audiobook',
          deletedAt: null,
          audiobook: { id: 'ab-4', title: 'T', author: 'A', audibleAsin: null },
        },
      },
    ]);
    // Make addAutoBlock blow up — must not strand the torrent.
    blocklistMock.addAutoBlock.mockRejectedValueOnce(new Error('redis down'));
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(
      makeStaleClientMock([makeStaleTorrent()], deleteFn)
    );

    const { processDetectStalledDownloads } = await import(
      '@/lib/processors/detect-stalled-downloads.processor'
    );
    const result = await processDetectStalledDownloads({ jobId: 'stage2-6' });

    // Delete fired despite the upstream block-and-research failure
    expect(deleteFn).toHaveBeenCalledWith('hashlowercase1', true);
    expect(result.staleLinkedDeleted).toBe(1);
    // Error was counted into the scan-errors bucket so we can surface it
    expect(result.qbtScanErrors).toBeGreaterThanOrEqual(1);
  });
});
