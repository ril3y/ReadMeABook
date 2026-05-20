/**
 * Component: Infinite Scroll Hook
 * Documentation: documentation/frontend/components.md
 *
 * Attaches an IntersectionObserver to a sentinel ref and fires `onLoadMore`
 * whenever the sentinel scrolls into view, gated by `hasMore` and an
 * in-flight `isLoading` flag so we don't fire a flood of requests.
 *
 * Usage:
 *   const sentinelRef = useRef<HTMLDivElement>(null);
 *   useInfiniteScroll({ ref: sentinelRef, hasMore, isLoading, onLoadMore });
 *   ...
 *   <div ref={sentinelRef} />
 */

'use client';

import { useEffect, RefObject } from 'react';

interface Options {
  ref: RefObject<HTMLElement | null>;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  /** Distance in CSS pixels before the sentinel hits the viewport at which
   *  loadMore should fire. Larger = earlier prefetch. Default 400. */
  rootMargin?: number;
}

export function useInfiniteScroll({
  ref,
  hasMore,
  isLoading,
  onLoadMore,
  rootMargin = 400,
}: Options) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!hasMore) return;

    // Bail gracefully on SSR or environments lacking IntersectionObserver.
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries.some(e => e.isIntersecting);
        if (isIntersecting && hasMore && !isLoading) {
          onLoadMore();
        }
      },
      { rootMargin: `0px 0px ${rootMargin}px 0px` }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, hasMore, isLoading, onLoadMore, rootMargin]);
}
