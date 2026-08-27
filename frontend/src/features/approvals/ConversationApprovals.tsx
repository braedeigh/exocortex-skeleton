/**
 * ConversationApprovals — an agent's proposals, drawn INSIDE the chat
 * transcript of the session that made them.
 *
 * What it does: reads the same 3s /api/pending poll as the window-wide
 * host, keeps only the entries whose `conv` is this conversation, and
 * renders each one as a card in the message column — after the agent's
 * latest reply, where its words are, in the same left-ruled card language
 * the transcript already uses for decisions. Every card carries the kind's
 * own editor (the native to-do form for an add, the note-with-citation for
 * a note, the field list for a patch) and its Approve / Deny. The decision
 * logic is useApprovalDecisions, shared with the global sheet; only where
 * it's drawn differs. While mounted it claims the conversation in openConvs
 * so the global host doesn't also show these center-screen.
 *
 * All of this conversation's proposals show at once (they're a batch from
 * one agent, not a queue to page through). Nothing touches the list until
 * Approve; a decided card leaves the transcript and the ledger keeps it.
 *
 * Prompt distilled: "I want it to show explicitly over the session that
 * made it, inside the chat window, not just observatory."
 */
import { useEffect } from 'react';
import { ToastStack } from '../../ui';
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
  const { busy, toasts } = d;

  if (!items.length && !toasts.length) return null;

  return (
    <>
      {items.map((change) => {
        const entry = getApprovalEditor(change.kind);
        const Editor = entry?.Editor ?? GenericApprovalEditor;
        const title = entry?.title ?? 'Approve change?';
        const who = change.by ? agentLabel(change.by) : 'This agent';
        return (
          <div key={change.id} className={styles.card} role="group" aria-label={`${who}: ${title}`}>
            <div className={styles.head}>
              <span className={styles.eyebrow}>✦ {who} proposes</span>
              <span className={styles.title}>{title}</span>
              {change.created ? <span className={styles.when}>{change.created.slice(11, 16)}</span> : null}
            </div>
            <div className={styles.body}>
              <Editor
                change={change}
                busy={busy}
                onApprove={(plan) => {
                  void d.runApprove(change, plan);
                }}
                onDeny={() => {
                  void d.runDeny(change);
                }}
              />
            </div>
          </div>
        );
      })}
      <ToastStack toasts={toasts} onDismiss={d.dismissToast} />
    </>
  );
}
