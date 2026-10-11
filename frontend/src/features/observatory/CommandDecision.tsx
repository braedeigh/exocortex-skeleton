/**
 * CommandDecision.tsx — the body of an approval card: "wants to run", the exact
 * command, a Once/Always toggle, Deny and Approve. Used by the session card in
 * the room view (SessionCard.tsx) and by the in-chat card (ChatApprovalCard.tsx),
 * so she sees and taps the same thing in both places. The logic behind the
 * buttons is useCommandDecision.ts.
 */
import { useCommandDecision } from './useCommandDecision';
import styles from './SessionLane.module.css';

export function CommandDecision({
  convId,
  command,
  onChanged,
}: {
  convId: string;
  command: string;
  onChanged?: () => void;
}) {
  const d = useCommandDecision(convId, onChanged);
  return (
    <>
      <div className={styles.approvalLabel}>wants to run</div>
      <code className={styles.command}>{command}</code>
      <div className={styles.approvalActions}>
        {/* Once is the default — the safest scope (Terra). */}
        <div className={styles.scopeToggle} role="group" aria-label="Approval scope">
          <button
            type="button"
            className={[styles.scopeBtn, !d.sticky ? styles.scopeOn : ''].filter(Boolean).join(' ')}
            aria-pressed={!d.sticky}
            onClick={() => d.setSticky(false)}
            title="Allow just this once"
          >
            Once
          </button>
          <button
            type="button"
            className={[styles.scopeBtn, d.sticky ? styles.scopeOn : ''].filter(Boolean).join(' ')}
            aria-pressed={d.sticky}
            onClick={() => d.setSticky(true)}
            title="Allow this command for the rest of the session"
          >
            Always
          </button>
        </div>
        <div className={styles.decideBtns}>
          <button type="button" className={styles.denyBtn} disabled={d.deciding} onClick={d.deny}>
            Deny
          </button>
          <button
            type="button"
            className={styles.approveBtn}
            disabled={d.deciding}
            onClick={d.approve}
          >
            {d.deciding ? 'Sending…' : d.sticky ? 'Approve · always' : 'Approve · once'}
          </button>
        </div>
      </div>
      {/* A wait is said out loud, so it never looks like a drop. */}
      {d.queued ? (
        <div className={styles.decideQueued} role="status">
          Recorded — it’ll carry on the moment its current reply finishes.
        </div>
      ) : null}
      {/* A decision that never landed says so here. Silence was the whole bug. */}
      {d.decideErr ? (
        <div className={styles.decideError} role="alert">
          Couldn’t record that — {d.decideErr}. Tap again.
        </div>
      ) : null}
    </>
  );
}
