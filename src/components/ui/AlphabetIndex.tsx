/**
 * Component: Alphabet Index (A-Z quick scroll)
 * Documentation: documentation/frontend/components.md
 *
 * Vertical floating list of letters A-Z (plus "#" for digits/symbols)
 * shown on the right edge of a scroll surface. Tapping a letter scrolls
 * the first item whose sort key starts with that letter into view.
 *
 * Active letters (those that actually exist in the dataset) render in
 * full opacity; letters with no matching item dim out so the user knows
 * what's reachable.
 */

'use client';

import React, { useMemo } from 'react';

const LETTERS = ['#', 'A','B','C','D','E','F','G','H','I','J','K','L','M',
                 'N','O','P','Q','R','S','T','U','V','W','X','Y','Z'] as const;

interface Props<T> {
  items: T[];
  /** Pulls the sort key from one item — usually the name/title field. */
  getKey: (item: T) => string;
  /** Called with the bucket letter; receiver scrolls to the right node. */
  onJump: (letter: string) => void;
  /** Optional class applied to the wrapping nav. Lets callers position it. */
  className?: string;
}

/** Bucket a name into "#" (digit/symbol/empty) or A..Z (uppercase). */
export function letterBucket(name: string | undefined | null): string {
  if (!name) return '#';
  const first = name.trim().charAt(0).toUpperCase();
  if (!first) return '#';
  if (first >= 'A' && first <= 'Z') return first;
  return '#';
}

export function AlphabetIndex<T>({ items, getKey, onJump, className = '' }: Props<T>) {
  const activeSet = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) s.add(letterBucket(getKey(it)));
    return s;
  }, [items, getKey]);

  return (
    <nav
      aria-label="Alphabet index"
      className={`hidden md:flex flex-col items-center gap-0.5 select-none ${className}`}
    >
      {LETTERS.map(letter => {
        const active = activeSet.has(letter);
        return (
          <button
            key={letter}
            type="button"
            onClick={() => active && onJump(letter)}
            disabled={!active}
            aria-label={`Jump to ${letter}`}
            className={`w-6 h-5 leading-5 text-[10px] font-semibold rounded
              ${active
                ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 cursor-pointer'
                : 'text-gray-300 dark:text-gray-600 cursor-default'}
            `}
          >
            {letter}
          </button>
        );
      })}
    </nav>
  );
}
