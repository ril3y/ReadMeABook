/**
 * Component: Admin Automation Settings API
 * Documentation: documentation/settings-pages.md
 *
 * Manages automation-wide behavioral knobs (currently: stalled-download
 * detection timeout).
 *
 * Read contract (consumed by the detect-stalled-downloads processor):
 *   - Config key: `automation.stall_timeout_days`
 *   - Category:   `automation`
 *   - Value:      string-encoded integer (1..365); default 7 when missing/invalid
 *
 *                 const raw = await config.get('automation.stall_timeout_days');
 *                 const days = parseInt(raw ?? '7', 10) || 7;
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Settings.Automation');

const CONFIG_KEY_STALL_TIMEOUT = 'automation.stall_timeout_days';
const CONFIG_KEY_MAX_PROGRESS = 'automation.stall_swap_max_progress';
const CONFIG_KEY_GLOBAL_THRESHOLD = 'automation.global_block_threshold';

const DEFAULT_STALL_TIMEOUT_DAYS = 7;
const MIN_STALL_TIMEOUT_DAYS = 1;
const MAX_STALL_TIMEOUT_DAYS = 365;

const DEFAULT_MAX_PROGRESS = 50;
const DEFAULT_GLOBAL_THRESHOLD = 3;
const MIN_GLOBAL_THRESHOLD = 1;
const MAX_GLOBAL_THRESHOLD = 100;

function parseStallTimeout(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_STALL_TIMEOUT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALL_TIMEOUT_DAYS;
  return Math.min(Math.max(n, MIN_STALL_TIMEOUT_DAYS), MAX_STALL_TIMEOUT_DAYS);
}

function parseMaxProgress(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_MAX_PROGRESS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_PROGRESS;
  return Math.min(Math.max(n, 0), 100);
}

function parseGlobalThreshold(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_GLOBAL_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GLOBAL_THRESHOLD;
  return Math.min(Math.max(n, MIN_GLOBAL_THRESHOLD), MAX_GLOBAL_THRESHOLD);
}

/**
 * GET /api/admin/settings/automation
 * Returns the current automation options.
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const configService = getConfigService();
        const [t, p, g] = await Promise.all([
          configService.get(CONFIG_KEY_STALL_TIMEOUT),
          configService.get(CONFIG_KEY_MAX_PROGRESS),
          configService.get(CONFIG_KEY_GLOBAL_THRESHOLD),
        ]);
        return NextResponse.json({
          stallTimeoutDays: parseStallTimeout(t),
          stallSwapMaxProgress: parseMaxProgress(p),
          globalBlockThreshold: parseGlobalThreshold(g),
        });
      } catch (error) {
        logger.error('Failed to fetch automation options', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: 'Failed to fetch automation options' },
          { status: 500 }
        );
      }
    });
  });
}

/**
 * PUT /api/admin/settings/automation
 * Persists automation options. Body: { stallTimeoutDays: number }
 */
export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const body = await request.json();
        const { stallTimeoutDays, stallSwapMaxProgress, globalBlockThreshold } = body ?? {};

        // Each field is optional but if present must be a number — admin UI
        // submits the whole block together so practically all three arrive,
        // but the API stays additive-safe.
        const updates: Array<{ key: string; value: string; description: string }> = [];

        let clampedTimeout: number | undefined;
        let clampedMaxProgress: number | undefined;
        let clampedThreshold: number | undefined;

        if (stallTimeoutDays !== undefined) {
          if (typeof stallTimeoutDays !== 'number' || !Number.isFinite(stallTimeoutDays)) {
            return NextResponse.json({ error: 'stallTimeoutDays must be a number' }, { status: 400 });
          }
          clampedTimeout = Math.min(
            Math.max(Math.floor(stallTimeoutDays), MIN_STALL_TIMEOUT_DAYS),
            MAX_STALL_TIMEOUT_DAYS
          );
          updates.push({
            key: CONFIG_KEY_STALL_TIMEOUT,
            value: String(clampedTimeout),
            description:
              'Days a download can stay in `downloading` status before the release is auto-swapped',
          });
        }

        if (stallSwapMaxProgress !== undefined) {
          if (typeof stallSwapMaxProgress !== 'number' || !Number.isFinite(stallSwapMaxProgress)) {
            return NextResponse.json({ error: 'stallSwapMaxProgress must be a number' }, { status: 400 });
          }
          clampedMaxProgress = Math.min(Math.max(Math.floor(stallSwapMaxProgress), 0), 100);
          updates.push({
            key: CONFIG_KEY_MAX_PROGRESS,
            value: String(clampedMaxProgress),
            description:
              'Stalled downloads at or above this progress percent are NOT swapped — they get more grace',
          });
        }

        if (globalBlockThreshold !== undefined) {
          if (typeof globalBlockThreshold !== 'number' || !Number.isFinite(globalBlockThreshold)) {
            return NextResponse.json({ error: 'globalBlockThreshold must be a number' }, { status: 400 });
          }
          clampedThreshold = Math.min(
            Math.max(Math.floor(globalBlockThreshold), MIN_GLOBAL_THRESHOLD),
            MAX_GLOBAL_THRESHOLD
          );
          updates.push({
            key: CONFIG_KEY_GLOBAL_THRESHOLD,
            value: String(clampedThreshold),
            description:
              'Independent stall failures of the same release before it becomes cross-request blocked',
          });
        }

        if (updates.length === 0) {
          return NextResponse.json(
            { error: 'Provide at least one of stallTimeoutDays, stallSwapMaxProgress, globalBlockThreshold' },
            { status: 400 }
          );
        }

        const configService = getConfigService();
        await configService.setMany(updates.map(u => ({ ...u, category: 'automation' })));
        for (const u of updates) configService.clearCache(u.key);

        logger.info('Automation options updated', {
          stallTimeoutDays: clampedTimeout,
          stallSwapMaxProgress: clampedMaxProgress,
          globalBlockThreshold: clampedThreshold,
        });

        return NextResponse.json({
          success: true,
          message: 'Automation options updated successfully',
          stallTimeoutDays: clampedTimeout,
          stallSwapMaxProgress: clampedMaxProgress,
          globalBlockThreshold: clampedThreshold,
        });
      } catch (error) {
        logger.error('Failed to update automation options', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to update automation options',
          },
          { status: 500 }
        );
      }
    });
  });
}
