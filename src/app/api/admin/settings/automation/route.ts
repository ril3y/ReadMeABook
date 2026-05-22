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
const DEFAULT_STALL_TIMEOUT_DAYS = 7;
const MIN_STALL_TIMEOUT_DAYS = 1;
const MAX_STALL_TIMEOUT_DAYS = 365;

function parseStallTimeout(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_STALL_TIMEOUT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALL_TIMEOUT_DAYS;
  return Math.min(Math.max(n, MIN_STALL_TIMEOUT_DAYS), MAX_STALL_TIMEOUT_DAYS);
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
        const stallTimeoutDays = parseStallTimeout(await configService.get(CONFIG_KEY_STALL_TIMEOUT));
        return NextResponse.json({ stallTimeoutDays });
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
        const { stallTimeoutDays } = body ?? {};

        if (typeof stallTimeoutDays !== 'number' || !Number.isFinite(stallTimeoutDays)) {
          return NextResponse.json(
            { error: 'stallTimeoutDays must be a number' },
            { status: 400 }
          );
        }

        const clamped = Math.min(
          Math.max(Math.floor(stallTimeoutDays), MIN_STALL_TIMEOUT_DAYS),
          MAX_STALL_TIMEOUT_DAYS
        );

        const configService = getConfigService();
        await configService.setMany([
          {
            key: CONFIG_KEY_STALL_TIMEOUT,
            value: String(clamped),
            category: 'automation',
            description:
              'Days a download can stay in `downloading` status before the release is auto-swapped',
          },
        ]);

        configService.clearCache(CONFIG_KEY_STALL_TIMEOUT);

        logger.info('Automation options updated', { stallTimeoutDays: clamped });

        return NextResponse.json({
          success: true,
          message: 'Automation options updated successfully',
          stallTimeoutDays: clamped,
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
