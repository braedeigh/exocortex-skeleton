/**
 * useApprovalDecisions — the approve / deny / dismiss / undo machinery that
 * used to live inside ApprovalsHost, pulled out so two surfaces can share
 * it: the window-wide host (a centered Sheet) and ConversationApprovals
 * (the same decisions, drawn inside one Observatory pane). Given the list
 * of queue items this surface owns, it auto-opens the first (FIFO, one at a
 * time), runs the kind's editor plan on Approve, logs the decision, drops
 * the entry, refreshes dashboard queries, and offers Undo on a toast.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import { denyPending, logDecision } from './api';
import { PENDING_QUERY_KEY } from './hooks';
import type { ApprovalCommitPlan, ApprovalUndo, PendingChange, PendingQueue } from './types';

/** Toast lifetime — matches the legacy undo toast (~5s). */
const TOAST_MS = 5000;

export interface ApprovalsToast {
  message: string;
  tone: 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}

export function useApprovalDecisions(items: PendingChange[], onToast?: (toast: ApprovalsToast) => void) {
  const queryClient = useQueryClient();
  const first: PendingChange | null = items[0] ?? null;

  const [active, setActive] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);
  /** Synchronous double-tap guard (the legacy `_changeBusy`) — state alone
   * can't stop two submits landing in the same tick. */
  const busyRef = useRef(false);
  /** Id the user closed without deciding — don't auto-reopen it. */
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);

  const pushToast = useCallback(
    (t: ApprovalsToast) => {
      if (onToast) {
        onToast(t);
        return;
      }
      const id = nextToastId.current++;
      setToasts((cur) => [...cur, { id, ...t }]);
      window.setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), TOAST_MS);
    },
    [onToast],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // Auto-open the first queued change (FIFO, one at a time).
  useEffect(() => {
    if (!first || active || busy) return;
    if (first.id === dismissedId) return;
    setActive(first);
  }, [first, active, busy, dismissedId]);

  // If the active item vanished from our list (decided elsewhere, or its
  // pane opened and claimed it), let go of it.
  useEffect(() => {
    if (active && !items.some((p) => p.id === active.id)) setActive(null);
  }, [items, active]);

  /** Drop an id from the cached queue immediately so the auto-open effect
   * can't re-show a just-decided change while the refetch is in flight. */
  const removeFromCache = useCallback(
    (id: string) => {
      queryClient.setQueryData<PendingQueue>(PENDING_QUERY_KEY, (cur) =>
        cur ? { pending: cur.pending.filter((p) => p.id !== id) } : cur,
      );
    },
    [queryClient],
  );

  const refreshDashboard = useCallback(() => {
    // Legacy ApprovalKit.refresh()/loadDashboard(): a just-committed change
    // shows immediately on whatever native page is open.
    void queryClient.invalidateQueries({ queryKey: ['data'] });
  }, [queryClient]);

  const runUndo = useCallback(
    (undo: ApprovalUndo, change: PendingChange) => {
      if ('reopen' in undo) {
        setDismissedId(null);
        setActive(change);
        return;
      }
      void (async () => {
        try {
          await undo.run();
        } catch (e) {
          pushToast({
            message: e instanceof ApiError ? e.message : 'Undo failed — the change is still applied',
            tone: 'error',
          });
        }
        refreshDashboard();
      })();
    },
    [refreshDashboard, pushToast],
  );

  async function runApprove(change: PendingChange, plan: ApprovalCommitPlan) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const undo = await plan.commit();
      void logDecision({
        action: 'approve',
        kind: change.kind,
        proposed: change.payload,
        final: plan.final,
      });
      if (plan.dequeue !== false) await denyPending(change.id);
      removeFromCache(change.id);
      setActive(null);
      setDismissedId(null);
      void queryClient.invalidateQueries({ queryKey: PENDING_QUERY_KEY });
      refreshDashboard();
      pushToast({
        message: plan.toastMessage,
        tone: 'info',
        ...(undo ? { actionLabel: 'Undo', onAction: () => runUndo(undo, change) } : {}),
      });
    } catch (e) {
      pushToast({
        message: e instanceof ApiError ? e.message : 'Failed to apply change',
        tone: 'error',
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function runDeny(change: PendingChange) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      void logDecision({ action: 'deny', kind: change.kind, proposed: change.payload, final: null });
      await denyPending(change.id);
      removeFromCache(change.id);
      setActive(null);
      setDismissedId(null);
      void queryClient.invalidateQueries({ queryKey: PENDING_QUERY_KEY });
    } catch (e) {
      pushToast({
        message: e instanceof ApiError ? e.message : 'Failed to deny change',
        tone: 'error',
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function dismiss() {
    if (busy || !active) return;
    setDismissedId(active.id);
    setActive(null);
  }

  function reopen() {
    setDismissedId(null);
    if (first) setActive(first);
  }

  return { first, active, busy, toasts, dismissToast, runApprove, runDeny, dismiss, reopen };
}
