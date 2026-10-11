/**
 * ChatApprovalCard — a command this session's agent wants to run, shown
 * INSIDE its own chat, after its latest words, whenever the act-vs-ask gate
 * has stopped it. Same card body as the room view's (CommandDecision.tsx),
 * in the transcript's left-ruled card language — so she can Approve or Deny
 * right where she's reading, in whatever chat is asking.
 *
 * Where the facts come from: the roster (useSessionRoster), which already
 * carries each session's `awaiting_approval`. Polled every 5s while this chat
 * is open; the room view shares the same query, so it's one fetch, not two.
 * Deciding in either place clears both — the pending command lives on the
 * server, not in either card.
 *
 * Prompt: "No, I mean the approve card only" — make it show in whatever chat
 * is making the request.
 */
import { useSessionRoster } from './api';
import { CommandDecision } from './CommandDecision';
import styles from '../approvals/ConversationApprovals.module.css';

export function ChatApprovalCard({ convId }: { convId: string }) {
  const { data, refetch } = useSessionRoster(true);
  const mine = (data?.sessions ?? []).find((s) => s.id === convId);
  const pending = mine?.awaiting_approval;
  if (!pending?.command) return null;
  return (
    <div className={styles.card} role="group" aria-label="This session needs your OK">
      <div className={styles.head}>
        <span className={styles.eyebrow}>✦ needs your OK</span>
      </div>
      <div className={styles.body}>
        {/* keyed by command: a new request gets a fresh card, never the last
            one's half-finished state */}
        <CommandDecision
          key={pending.command}
          convId={convId}
          command={pending.command}
          onChanged={() => void refetch()}
        />
      </div>
    </div>
  );
}
