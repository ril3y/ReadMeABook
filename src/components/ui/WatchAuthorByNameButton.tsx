/**
 * Component: Watch Author By Name Button
 * Documentation: documentation/features/watched-lists.md
 *
 * Variant of [[WatchAuthorButton]] for callers that only know the author's
 * display name (e.g. the Library Author detail page sourced from
 * plex_library.author, which has no ASIN). On first click, resolves the
 * name to an Audnexus author entry, then delegates to the same hooks the
 * regular WatchAuthorButton uses.
 *
 * Resolution behavior:
 *   - 0 matches → inline "not found on Audible" message
 *   - 1 match  → uses it directly
 *   - 2+ matches → uses the first (highest-confidence) result; rare in
 *     practice because the search API already dedupes
 *
 * Once a name has been resolved successfully, the resolved ASIN is cached
 * in component state so re-clicks (unwatch/rewatch) skip the lookup.
 */

'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  useWatchedAuthors,
  useAddWatchedAuthor,
  useDeleteWatchedAuthor,
} from '@/lib/hooks/useWatchedAuthors';
import { ConfirmModal } from './ConfirmModal';

interface Props {
  authorName: string;
}

interface ResolvedAuthor {
  asin: string;
  name: string;
  image?: string;
}

export function WatchAuthorByNameButton({ authorName }: Props) {
  const { accessToken } = useAuth();
  const { authors } = useWatchedAuthors();
  const { addAuthor, isLoading: isAdding } = useAddWatchedAuthor();
  const { deleteAuthor, isLoading: isDeleting } = useDeleteWatchedAuthor();

  const [resolved, setResolved] = useState<ResolvedAuthor | null>(null);
  const [resolutionState, setResolutionState] = useState<
    'idle' | 'resolving' | 'not-found' | 'resolved'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // If a watched_authors row already matches this display name (case-insensitive),
  // surface its ASIN immediately so the button can show "Watching" without a
  // round-trip to Audnexus.
  useEffect(() => {
    if (resolved) return;
    const match = authors.find(
      (a) => a.authorName.trim().toLowerCase() === authorName.trim().toLowerCase()
    );
    if (match) {
      setResolved({ asin: match.authorAsin, name: match.authorName, image: match.coverArtUrl ?? undefined });
      setResolutionState('resolved');
    }
  }, [authors, authorName, resolved]);

  const watchedEntry = resolved
    ? authors.find((a) => a.authorAsin === resolved.asin)
    : undefined;
  const isWatching = !!watchedEntry;
  const isLoading = isAdding || isDeleting || resolutionState === 'resolving';

  // Lookup the author on Audnexus when the user clicks (and we don't already
  // have a resolution). Avoids hammering Audnexus on every page load.
  const resolveName = async (): Promise<ResolvedAuthor | null> => {
    setResolutionState('resolving');
    setError(null);
    try {
      const res = await fetch(`/api/authors/search?name=${encodeURIComponent(authorName)}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      });
      if (!res.ok) {
        throw new Error(`Lookup failed (HTTP ${res.status})`);
      }
      const data = await res.json();
      const list: Array<{ asin: string; name: string; image?: string }> = data?.authors ?? [];
      if (list.length === 0) {
        setResolutionState('not-found');
        return null;
      }
      // Take the first result. The search API already dedupes; for ambiguous
      // names we trust Audnexus's ranking.
      const first = list[0];
      const found: ResolvedAuthor = { asin: first.asin, name: first.name, image: first.image };
      setResolved(found);
      setResolutionState('resolved');
      return found;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
      setResolutionState('idle');
      return null;
    }
  };

  const handleClick = async () => {
    setError(null);
    if (isWatching && watchedEntry) {
      // Unwatch immediately (no confirmation)
      try {
        await deleteAuthor(watchedEntry.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      }
      return;
    }

    // Need an ASIN before we can watch.
    let target = resolved;
    if (!target) {
      target = await resolveName();
      if (!target) return;
    }

    setShowConfirm(true);
  };

  const handleConfirmWatch = async () => {
    setShowConfirm(false);
    if (!resolved) return;
    setError(null);
    try {
      await addAuthor(resolved.asin, resolved.name, resolved.image);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isLoading}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
          isWatching
            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
            : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
        } ${isLoading ? 'opacity-60 cursor-wait' : ''}`}
        title={
          isWatching
            ? 'New releases by this author are auto-requested daily'
            : 'Watch this author for new releases (auto-request when they publish)'
        }
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          {isWatching ? (
            <path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />
          ) : (
            <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9V5h2v4h4v2h-4v4H9v-4H5V9h4z" />
          )}
        </svg>
        {resolutionState === 'resolving'
          ? 'Looking up…'
          : isWatching
            ? 'Watching'
            : 'Watch for new releases'}
      </button>
      {resolutionState === 'not-found' && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Audnexus didn&rsquo;t find a matching author. Try the public Authors search.
        </span>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}

      <ConfirmModal
        isOpen={showConfirm}
        title={`Watch ${resolved?.name ?? authorName}?`}
        message="RMAB will check Audible daily for new releases by this author and auto-request anything new."
        confirmText="Watch"
        cancelText="Cancel"
        onConfirm={handleConfirmWatch}
        onClose={() => setShowConfirm(false)}
      />
    </div>
  );
}
