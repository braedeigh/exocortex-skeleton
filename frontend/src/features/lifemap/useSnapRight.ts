import { useCallback, useEffect, useRef } from 'react';

/**
 * Snap a horizontally-scrolling grid to its right edge (today's dot) and
 * re-snap whenever it first gets real size — port of renderHabitTracker's
 * ResizeObserver in habits.js. scrollWidth reads 0 while the grid is inside
 * a closed <details> or an inactive tab, so the synchronous assignment alone
 * silently no-ops there; observing resize covers the details-opens /
 * tab-becomes-active / rotate cases.
 *
 * Returns a callback ref to put on the scrollable element.
 */
export function useSnapRight(): (el: HTMLElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          const t = entry.target as HTMLElement;
          t.scrollLeft = t.scrollWidth;
        }
      }
    });
    obs.observe(el);
    observerRef.current = obs;
  }, []);
}
