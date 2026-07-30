/**
 * useRoomLayout.ts — loads and saves one front's room arrangement
 * (/api/fronts/layout/<front>, routes/fronts.py).
 *
 * The arrangement is local state while she's dragging and only reaches the
 * server once she stops: a drag fires dozens of geometry updates a second and
 * every one of them would otherwise be a POST. `commit` debounces, skips saves
 * that didn't actually change anything, and never blocks the drag on the
 * network — the canvas is always driven by local state, the server is just
 * where it's remembered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { sameLayout, type RoomLayout } from './roomLayout';

const SAVE_DEBOUNCE_MS = 600;

interface LayoutResponse {
  front: string;
  panels: RoomLayout;
}

export function roomLayoutKey(frontId: string) {
  return ['fronts', 'layout', frontId] as const;
}

/** Saved arrangement for a front. Absent/empty = never furnished. */
export function useSavedRoomLayout(frontId: string) {
  return useQuery({
    queryKey: roomLayoutKey(frontId),
    queryFn: ({ signal }) =>
      api.get<LayoutResponse>(`/api/fronts/layout/${encodeURIComponent(frontId)}`, signal),
  });
}

/**
 * A debounced writer for the arrangement. Returns `commit`, which takes the
 * layout as it now stands; the last call inside the debounce window wins.
 */
export function useRoomLayoutSaver(frontId: string) {
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the server is believed to hold. A commit matching this is a no-op,
  // which is what stops a drag that ends where it began from saving.
  const persisted = useRef<RoomLayout | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Switching fronts must not let a pending save land on the new front's key.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    persisted.current = null;
  }, [frontId]);

  const setBaseline = useCallback((layout: RoomLayout) => {
    persisted.current = layout;
  }, []);

  const commit = useCallback(
    (layout: RoomLayout) => {
      if (persisted.current && sameLayout(persisted.current, layout)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const snapshot = layout;
        api
          .post(`/api/fronts/layout/${encodeURIComponent(frontId)}`, { panels: snapshot })
          .then(() => {
            persisted.current = snapshot;
            setError(null);
          })
          .catch(() => setError('Couldn’t save the arrangement'));
      }, SAVE_DEBOUNCE_MS);
    },
    [frontId],
  );

  /** "Put it back" — clears the saved arrangement so the room re-tiles. */
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    persisted.current = {};
    return api
      .post(`/api/fronts/layout/${encodeURIComponent(frontId)}`, { panels: {} })
      .catch(() => setError('Couldn’t reset the arrangement'));
  }, [frontId]);

  return { commit, reset, setBaseline, error };
}
