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
 *    the pill up; tap it to reopen.
 *  - **A change that names its conversation is not this host's** while that
 *    conversation is open in this window: ConversationApprovals draws it
 *    inside that Observatory pane instead (openConvs.ts decides). It falls
 *    back here the moment the pane closes, so nothing is ever unreachable.
 *  - Approve commits via the kind's NATIVE endpoint (registry editor), logs
 *    the decision to the ledger, drops the queue entry, refreshes dashboard
 *    queries, and offers Undo on a toast. Deny logs + drops the entry.
 *    Kinds without a registered editor fall back to the generic field
 *    editor, which commits server-side via POST /api/pending/approve.
 */
import { useSyncExternalStore } from 'react';
import { Sheet, ToastStack } from '../../ui';
import { GenericApprovalEditor } from './GenericApprovalEditor';
import { usePendingQueue } from './hooks';
import { itemsUnowned, subscribeOpenConvs } from './openConvs';
import { getApprovalEditor } from './registry';
import { useApprovalDecisions } from './useApprovalDecisions';
import type { ApprovalsToast } from './useApprovalDecisions';
import styles from './ApprovalsHost.module.css';
import './builtinEditors';

export type { ApprovalsToast };

export interface ApprovalsHostProps {
  /**
   * Optional toast delegate. Omitted (the default): the host renders its own
   * ToastStack. Provided: every toast (undo confirmations + errors) is handed
   * to the app instead and nothing toast-related is rendered here.
   */
  onToast?: (toast: ApprovalsToast) => void;
}

let tick = 0;
const subscribeTick = (cb: () => void) => subscribeOpenConvs(() => { tick++; cb(); });
const getTick = () => tick;

export function ApprovalsHost({ onToast }: ApprovalsHostProps) {
  const { data } = usePendingQueue();
  // Re-render when a pane claims/releases a conversation, so an item can
  // move between this host and the pane without a poll in between.
  useSyncExternalStore(subscribeTick, getTick);
  const items = itemsUnowned(data?.pending ?? []);
  const d = useApprovalDecisions(items, onToast);
  const { active, busy, toasts } = d;

  // Queue empty, no sheet, no toasts → render nothing at all.
  if (!items.length && !active && !toasts.length) return null;

  const entry = active ? getApprovalEditor(active.kind) : undefined;
  const Editor = entry?.Editor ?? GenericApprovalEditor;
  const title = entry?.title ?? 'Approve change?';

  return (
    <>
      {!active && items.length > 0 ? (
        <button type="button" className={styles.banner} onClick={d.reopen}>
          <span className={styles.badge}>{items.length}</span>
          <span>{items.length === 1 ? 'change awaiting approval' : 'changes awaiting approval'}</span>
          <span className={styles.review}>Review</span>
        </button>
      ) : null}

      {active ? (
        <Sheet open title={title} onClose={d.dismiss}>
          <Editor
            key={active.id}
            change={active}
            busy={busy}
            onApprove={(plan) => {
              void d.runApprove(active, plan);
            }}
            onDeny={() => {
              void d.runDeny(active);
            }}
          />
        </Sheet>
      ) : null}

      {!onToast ? <ToastStack toasts={toasts} onDismiss={d.dismissToast} /> : null}
    </>
  );
}

export default ApprovalsHost;
