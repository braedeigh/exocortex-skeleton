/**
 * ApprovalsHost — the pending-change approval surface (React port of
 * static/js/pending.js + static/js/approvals/*). Mount ONCE at the shell
 * root; it is self-contained.
 *
 * Mount contract:
 *  - Must render inside the app's shared <QueryClientProvider> (main.tsx).
 *    No router dependency, no other providers, no required props.
 *  - Toasts: renders its OWN <ToastStack> internally by default — do not
 *    wrap it in one. Pass `onToast` to route approval toasts into an
 *    app-level stack instead; the internal stack is then not rendered.
 *
 * Behavior:
 *  - Polls GET /api/pending every 3s (paused while the tab is hidden).
 *  - Renders nothing while the queue is empty (undo toasts linger briefly
 *    after the last decision).
 *  - When items exist: a floating count pill, and the FIRST item's approval
 *    sheet auto-opens (FIFO, one at a time — legacy checkPendingChanges).
 *    Closing the sheet without deciding keeps that item queued and leaves
 *    the pill up; tap it to reopen. (Legacy re-popped the same modal every
 *    3s; the pill replaces that nag.)
 *  - Approve commits via the kind's NATIVE endpoint (registry editor), logs
 *    the decision to the ledger, drops the queue entry, refreshes dashboard
 *    queries, and offers Undo on a toast. Deny logs + drops the entry.
 *    Kinds without a registered editor fall back to the generic field
 *    editor, which commits server-side via POST /api/pending/approve.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Sheet, ToastStack } from '../../ui';
import type { ToastItem } from '../../ui';
import { denyPending, logDecision } from './api';
import { GenericApprovalEditor } from './GenericApprovalEditor';
import { PENDING_QUERY_KEY, usePendingQueue } from './hooks';
import { getApprovalEditor } from './registry';
import type { ApprovalCommitPlan, ApprovalUndo, PendingChange, PendingQueue } from './types';
import styles from './ApprovalsHost.module.css';
import './builtinEditors';

/** Toast lifetime — matches the legacy undo toast (~5s). */
const TOAST_MS = 5000;

export interface ApprovalsToast {
  message: string;
  tone: 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}

export interface ApprovalsHostProps {
  /**
   * Optional toast delegate. Omitted (the default): the host renders its own
   * ToastStack. Provided: every toast (undo confirmations + errors) is handed
   * to the app instead and nothing toast-related is rendered here.
   */
  onToast?: (toast: ApprovalsToast) => void;
}

export function ApprovalsHost({ onToast }: ApprovalsHostProps) {
  const queryClient = useQueryClient();
  const { data } = usePendingQueue();
  const items = data?.pending ?? [];
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
        // Best-effort undo (legacy symptoms flow): reopen this change's
        // editor. It's already off the queue — deciding again just commits
        // again / no-ops the dequeue.
        setDismissedId(null);
        setActive(change);
        return;
      }
      void (async () => {
        try {
          await undo.run();
        } catch (e) {
          // Undo is best-effort (legacy), but say it failed — the change is
          // still applied and silence would read as a successful revert.
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
      // Commit failed — the item stays queued and the editor stays open.
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

  function dismissSheet() {
    if (busy || !active) return;
    setDismissedId(active.id);
    setActive(null);
  }

  // Queue empty, no sheet, no toasts → render nothing at all.
  if (!items.length && !active && !toasts.length) return null;

  const entry = active ? getApprovalEditor(active.kind) : undefined;
  const Editor = entry?.Editor ?? GenericApprovalEditor;
  const title = entry?.title ?? 'Approve change?';

  return (
    <>
      {!active && items.length > 0 ? (
        <button
          type="button"
          className={styles.banner}
          onClick={() => {
            setDismissedId(null);
            if (first) setActive(first);
          }}
        >
          <span className={styles.badge}>{items.length}</span>
          <span>{items.length === 1 ? 'change awaiting approval' : 'changes awaiting approval'}</span>
          <span className={styles.review}>Review</span>
        </button>
      ) : null}

      {active ? (
        <Sheet open title={title} onClose={dismissSheet}>
          <Editor
            key={active.id}
            change={active}
            busy={busy}
            onApprove={(plan) => {
              void runApprove(active, plan);
            }}
            onDeny={() => {
              void runDeny(active);
            }}
          />
        </Sheet>
      ) : null}

      {!onToast ? <ToastStack toasts={toasts} onDismiss={dismissToast} /> : null}
    </>
  );
}

export default ApprovalsHost;
