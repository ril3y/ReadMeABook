/**
 * Component: Admin Indexer Options Settings API
 * Documentation: documentation/settings-pages.md
 *
 * Manages indexer-wide behavioral options that are not tied to a specific
 * indexer connection (e.g., auto-search behavior toggles).
 *
 * Read contract (consumed by background auto-search workers):
 *   - Config key: `indexer.skip_unreleased`
 *   - Category:   `indexer`
 *   - Value:      string `'true'` | `'false'`
 *   - Default:    ON when the key is missing OR its value is anything other
 *                 than the exact string `'false'`. In other words, skipping
 *                 unreleased books is enabled unless the admin explicitly
 *                 opted out. Workers MUST match this contract:
 *
 *                   const skip = (await config.get('indexer.skip_unreleased')) !== 'false';
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Settings.IndexerOptions');

const CONFIG_KEY = 'indexer.skip_unreleased';
const CONFIG_KEY_MIN_QUALITY = 'indexer.min_quality_score';
const CONFIG_KEY_MIN_SEEDERS = 'indexer.min_seeders';
const DEFAULT_MIN_QUALITY = 25;
// Default 1: require at least one alive peer with the complete file.
// 0 = filter off entirely (dead torrents allowed). Clamped 0..100 — 100 is
// a generous practical ceiling; if you genuinely need more, dial it via
// the configuration table directly.
const DEFAULT_MIN_SEEDERS = 1;
const MAX_MIN_SEEDERS = 100;

function parseMinQuality(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_MIN_QUALITY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_QUALITY;
  return Math.min(Math.max(n, 0), 100);
}

function parseMinSeeders(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MIN_SEEDERS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_SEEDERS;
  return Math.min(Math.max(n, 0), MAX_MIN_SEEDERS);
}

/**
 * GET /api/admin/settings/indexer-options
 * Returns the current indexer-wide options.
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const configService = getConfigService();
        const [skipRaw, qualityRaw, seedersRaw] = await Promise.all([
          configService.get(CONFIG_KEY),
          configService.get(CONFIG_KEY_MIN_QUALITY),
          configService.get(CONFIG_KEY_MIN_SEEDERS),
        ]);

        // skipUnreleased default ON: missing or any value other than 'false' is enabled.
        const skipUnreleased = skipRaw !== 'false';
        const minQualityScore = parseMinQuality(qualityRaw);
        const minSeeders = parseMinSeeders(seedersRaw);

        return NextResponse.json({ skipUnreleased, minQualityScore, minSeeders });
      } catch (error) {
        logger.error('Failed to fetch indexer options', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: 'Failed to fetch indexer options' },
          { status: 500 }
        );
      }
    });
  });
}

/**
 * PUT /api/admin/settings/indexer-options
 * Persists indexer-wide options. Body: { skipUnreleased: boolean }
 */
export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const body = await request.json();
        const { skipUnreleased, minQualityScore, minSeeders } = body ?? {};

        const updates: Array<{ key: string; value: string; description: string }> = [];

        if (skipUnreleased !== undefined) {
          if (typeof skipUnreleased !== 'boolean') {
            return NextResponse.json(
              { error: 'skipUnreleased must be a boolean' },
              { status: 400 }
            );
          }
          updates.push({
            key: CONFIG_KEY,
            value: String(skipUnreleased),
            description: 'Skip auto-searches for books with future release dates',
          });
        }

        let clampedQuality: number | undefined;
        if (minQualityScore !== undefined) {
          if (typeof minQualityScore !== 'number' || !Number.isFinite(minQualityScore)) {
            return NextResponse.json(
              { error: 'minQualityScore must be a number' },
              { status: 400 }
            );
          }
          clampedQuality = Math.min(Math.max(Math.floor(minQualityScore), 0), 100);
          updates.push({
            key: CONFIG_KEY_MIN_QUALITY,
            value: String(clampedQuality),
            description:
              'Minimum ranking score (0-100) for an indexer result to be auto-grabbed',
          });
        }

        let clampedSeeders: number | undefined;
        if (minSeeders !== undefined) {
          if (typeof minSeeders !== 'number' || !Number.isFinite(minSeeders)) {
            return NextResponse.json(
              { error: 'minSeeders must be a number' },
              { status: 400 }
            );
          }
          clampedSeeders = Math.min(Math.max(Math.floor(minSeeders), 0), MAX_MIN_SEEDERS);
          updates.push({
            key: CONFIG_KEY_MIN_SEEDERS,
            value: String(clampedSeeders),
            description:
              'Minimum seeders required for a torrent candidate to be auto-grabbed (0 disables)',
          });
        }

        if (updates.length === 0) {
          return NextResponse.json(
            { error: 'Provide at least one of skipUnreleased, minQualityScore, minSeeders' },
            { status: 400 }
          );
        }

        const configService = getConfigService();
        await configService.setMany(updates.map(u => ({ ...u, category: 'indexer' })));
        for (const u of updates) configService.clearCache(u.key);

        logger.info('Indexer options updated', {
          skipUnreleased,
          minQualityScore: clampedQuality,
          minSeeders: clampedSeeders,
        });

        return NextResponse.json({
          success: true,
          message: 'Indexer options updated successfully',
          skipUnreleased,
          minQualityScore: clampedQuality,
          minSeeders: clampedSeeders,
        });
      } catch (error) {
        logger.error('Failed to update indexer options', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to update indexer options',
          },
          { status: 500 }
        );
      }
    });
  });
}
