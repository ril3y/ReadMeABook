/**
 * Component: Library ID Resolution Helper
 * Documentation: documentation/frontend/components.md
 *
 * Shared helper used by every API route that reads from the library
 * cache (plex_library): resolves the appropriate library identifier
 * based on the backend mode (Plex vs Audiobookshelf) and returns a
 * NextResponse 400 when the relevant library isn't configured.
 *
 * Extracted from the duplicated inline resolveLibraryId() that appeared
 * in src/app/api/bookdate/library/route.ts and (when this branch lands)
 * the new /api/library/* routes.
 */

import { NextResponse } from 'next/server';
import { getConfigService } from '@/lib/services/config.service';

export type LibraryIdResult =
  | { ok: true; libraryId: string; backendMode: 'plex' | 'audiobookshelf' | string }
  | { ok: false; response: NextResponse };

export async function resolveLibraryId(): Promise<LibraryIdResult> {
  const configService = getConfigService();
  const backendMode = await configService.getBackendMode();

  if (backendMode === 'audiobookshelf') {
    const absLibraryId = await configService.get('audiobookshelf.library_id');
    if (!absLibraryId) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'NoLibraryConfigured', message: 'No Audiobookshelf library ID configured' },
          { status: 400 }
        ),
      };
    }
    return { ok: true, libraryId: absLibraryId, backendMode };
  }

  const plexConfig = await configService.getPlexConfig();
  if (!plexConfig.libraryId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'NoLibraryConfigured', message: 'No Plex library ID configured' },
        { status: 400 }
      ),
    };
  }
  return { ok: true, libraryId: plexConfig.libraryId, backendMode };
}
