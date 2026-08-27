/**
 * ConversationApprovals — the approval sheet drawn INSIDE one Observatory
 * pane, for the changes that conversation's agent proposed.
 *
 * What it does: reads the same 3s /api/pending poll as the global host,
 * keeps only the entries whose `conv` is this pane's conversation, and pops
 * them as a panel over the chat — a scrim covering just this tile, the
 * panel at the bottom where the eye already is (the composer). Approve /
 * edit / Deny are the exact same editors and decision logic as the
 * window-wide sheet (useApprovalDecisions); only where it appears differs.
 * While mounted it claims the conversation in openConvs so the global host
 * doesn't show the same change center-screen.
 *
 * Closing without deciding collapses it to a pill in the pane's corner;
 * tap to reopen. Nothing touches the list until Approve.
 *
 * Prompt distilled: "i want it to pop up over THIS pane. the observatory
 * pane where this agent is talking specifically."
 */
import { useEffect } from 'react';
import { Button, ToastStack } from '../../ui';
import { GenericApprovalEditor } from './GenericApprovalEditor';
import { usePendingQueue } from './hooks';
import { itemsForConv, registerOpenConv } from './openConvs';
import { getApprovalEditor } from './registry';
import { useApprovalDecisions } from './useApprovalDecisions';
import { agentLabel } from '../todos/provenance';
import styles from './ConversationApprovals.module.css';
import './builtinEditors';

export function ConversationApprovals({ convId }: { convId: string }) {
  useEffect(() => registerOpenConv(convId), [convId]);
  const { data } = usePendingQueue();
  const items = itemsForConv(data?.pending ?? [], convId);
  const d = useApprovalDecisions(items);
  const { active, busy, toasts } = d;

  if (!items.length && !active && !toasts.length) return null;

  const entry = active ? getApprovalEditor(active.kind) : undefined;
  const Editor = entry?.Editor ?? GenericApprovalEditor;
  const title = entry?.title ?? 'Approve change?';
  const who = active?.by ? agentLabel(active.by) : 'This agent';

  return (
    <>
      {!active && items.length > 0 ? (
        <button type="button" className={styles.pill} onClick={d.reopen}>
          <span className={styles.badge}>{items.length}</span>
          {items.length === 1 ? 'proposal from this agent' : 'proposals from this agent'} · Review
        </button>
      ) : null}

      {active ? (
        <div className={styles.scrim} role="dialog" aria-modal="false" aria-label={title}>
          <div className={styles.panel}>
            <div className={styles.head}>
              <div>
                <div className={styles.eyebrow}>{who} proposes</div>
                <div className={styles.title}>{title}</div>
              </div>
              <Button variant="secondary" type="button" onClick={d.dismiss} disabled={busy} aria-label="Later">
                Later
              </Button>
            </div>
            {items.length > 1 ? (
              <div className={styles.more}>+{items.length - 1} more waiting after this one</div>
            ) : null}
            <div className={styles.body}>
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
            </div>
          </div>
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={d.dismissToast} />
    </>
  );
}
