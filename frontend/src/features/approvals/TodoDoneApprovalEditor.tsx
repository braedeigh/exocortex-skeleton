/**
 * TodoDoneApprovalEditor — approval editor for kind "todo_done": "this journal
 * card looks like it closes to-do X — yes/no". Deliberately read-only: the
 * cricket's evidence (her verbatim quote + the card moment) renders above the
 * buttons and she rules on it, exactly like a thread nomination. Approve
 * commits server-side (routes/pending.py), which re-verifies the quote against
 * the card on disk and backdates the close to the card's moment.
 */
import { Button } from '../../ui';
import { approvePendingServerSide } from './api';
import { cardMoment, todoDoneFromChange } from './todoDoneApproval';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function TodoDoneApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const draft = todoDoneFromChange(change);

  function submit() {
    const final = {
      id: draft.todoId,
      text: draft.text,
      card_id: draft.cardId,
      quote: draft.quote,
    };
    onApprove({
      final,
      toastMessage: `Closed “${draft.text}”`,
      dequeue: false, // /api/pending/approve commits AND dequeues server-side
      commit: () => approvePendingServerSide(change.id, final).then(() => null),
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <span className={styles.label}>To-do</span>
        <div className={styles.readonlyValue}>{draft.text}</div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>You said</span>
        <div className={styles.evidence}>
          <div className={styles.evidenceItem}>
            <div className={styles.evidenceQuote}>“{draft.quote}”</div>
            <div className={styles.evidenceDate}>{cardMoment(draft.cardId)}</div>
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" type="button" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Mark done
        </Button>
      </div>
    </form>
  );
}
