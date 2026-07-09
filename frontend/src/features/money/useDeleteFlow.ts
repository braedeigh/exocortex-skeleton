/**
 * useDeleteFlow.ts — the two hooks behind every destructive action on the
 * Money tab, replacing the old window.confirm() dialogs with the SPA's
 * conventions (NotesPanel's two-step ×→"Sure?" + JournalPage's deferred
 * delete with an Undo toast).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PushOptions } from './useMoneyData';

/** Two-step confirm: first tap arms ("Sure?"), second tap within 3s fires. */
export function useConfirmDelete() {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const tap = useCallback(
    (key: string, onConfirm: () => void) => {
      if (timer.current) clearTimeout(timer.current);
      if (confirmKey === key) {
        setConfirmKey(null);
        onConfirm();
        return;
      }
      setConfirmKey(key);
      timer.current = setTimeout(() => setConfirmKey(null), 3000);
    },
    [confirmKey],
  );

  return { confirmKey, tap };
}

const UNDO_DELETE_MS = 5000;

/**
 * Deferred delete with Undo: the row disappears immediately (callers filter
 * `pending` keys out of what they render), an info toast offers Undo for 5s,
 * and only when that lapses does the real mutation fire. Un-elapsed deletes
 * flush on unmount so navigating away can't resurrect them.
 */
export function usePendingDeletes(push: (message: string, opts?: PushOptions) => number) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const timers = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; finalize: () => void }>>({});

  useEffect(
    () => () => {
      // Unmount: run every still-pending delete now instead of dropping it.
      Object.values(timers.current).forEach(({ timer, finalize }) => {
        clearTimeout(timer);
        finalize();
      });
      timers.current = {};
    },
    [],
  );

  const settle = useCallback((key: string) => {
    setPending((cur) => {
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
  }, []);

  const request = useCallback(
    (key: string, message: string, finalize: () => void) => {
      setPending((cur) => new Set(cur).add(key));
      const timer = setTimeout(() => {
        delete timers.current[key];
        settle(key);
        finalize();
      }, UNDO_DELETE_MS);
      timers.current[key] = { timer, finalize };
      push(message, {
        tone: 'info',
        actionLabel: 'Undo',
        duration: UNDO_DELETE_MS,
        onAction: () => {
          const entry = timers.current[key];
          if (entry) {
            clearTimeout(entry.timer);
            delete timers.current[key];
          }
          settle(key);
        },
      });
    },
    [push, settle],
  );

  return { pending, request };
}
