/**
 * Component: Blocked Results Filter
 * Documentation: documentation/backend/database.md
 *
 * Pre-rank filter applied by every automatic search path (audiobook, ebook, RSS)
 * to remove releases already on a request's blocklist. Matches case-insensitive
 * on release name and exact on hash (when both sides have one).
 *
 * Interactive admin search does NOT call this — admins see all results and the
 * UI surfaces a blocked badge instead.
 */

import { prisma } from '@/lib/db';
import { getBlocklistForRequest } from '@/lib/services/blocklist.service';
import { normalizeReleaseKey } from '@/lib/utils/release-key';

export interface FilterableResult {
  title: string;
  infoHash?: string;
}

export interface FilterBlockedResultsOutput<T> {
  kept: T[];
  blockedCount: number;
}

/**
 * Filter out search results that match either:
 *   1. A row on the request's own blocklist (per-request blocks)
 *   2. A row marked `global=true` on any request (cross-request blocks
 *      promoted by detect-stalled-downloads once a release stalls N times)
 *
 * Match rules:
 * - Name: case-insensitive exact via [[normalize-release-key]].
 * - Hash: exact, only when both the result and a blocklist row have one.
 *
 * Returns the original array unchanged when there are no results — common
 * hot-path case, so short-circuit. We still query for globals even when the
 * request's own blocklist is empty, since the global registry is decoupled.
 */
export async function filterBlockedResults<T extends FilterableResult>(
  requestId: string,
  results: T[]
): Promise<FilterBlockedResultsOutput<T>> {
  if (results.length === 0) {
    return { kept: results, blockedCount: 0 };
  }

  const [perRequest, globals] = await Promise.all([
    getBlocklistForRequest(requestId),
    prisma.blockedRelease.findMany({
      where: { global: true },
      select: { releaseKey: true, releaseHash: true },
    }),
  ]);

  if (perRequest.length === 0 && globals.length === 0) {
    return { kept: results, blockedCount: 0 };
  }

  const keys = new Set<string>();
  const hashes = new Set<string>();
  for (const b of perRequest) {
    keys.add(b.releaseKey);
    if (b.releaseHash) hashes.add(b.releaseHash);
  }
  for (const g of globals) {
    keys.add(g.releaseKey);
    if (g.releaseHash) hashes.add(g.releaseHash);
  }

  const kept = results.filter(r => {
    if (keys.has(normalizeReleaseKey(r.title))) return false;
    if (r.infoHash && hashes.has(r.infoHash)) return false;
    return true;
  });

  return { kept, blockedCount: results.length - kept.length };
}
