import { useNavigate } from '@tanstack/react-router';
import type { ResearchRoomState } from './api';
import styles from './NightCrew.module.css';

/**
 * ResearchDoor — the row on the roster that goes to /observatory/research:
 * her research desk sessions and the dispatched research workers, which used
 * to run in tmux panes nobody could open from the app.
 *
 * WHY A DOOR, NOT A ROOM BLOCK. The research lane is a real lane (a session
 * belongs to it, it fixes the cwd), but its sessions are mostly workers she
 * didn't open by hand — listing them among Personal and Coding would bury
 * her own conversations under receipts, the same reason Helpers is a door.
 * So it sits beside Night crew and Helpers, same shape, same styles.
 *
 * SAME RULE AS THE OTHER DOORS: it must not go silent. A worker still running
 * or a failure she hasn't seen warms the row and says so; it never navigates
 * for her.
 */
export function ResearchDoor({ state }: { state: ResearchRoomState | null }) {
  const navigate = useNavigate();
  const sessions = state?.sessions ?? [];
  const running = state?.running ?? 0;
  const failed = state?.failed ?? 0;
  const latest = sessions[0];

  // One sentence, in order of what asks something of her: a session still
  // going, else a failure she hasn't seen, else the last thing that ran.
  const line =
    running > 0
      ? `${running} running now`
      : failed > 0
        ? `${failed} failed — worth a look`
        : latest
          ? `Last: ${latest.title || latest.id}`
          : 'Your research desk. Workers land here too.';

  const wanting = running > 0 || failed > 0;

  return (
    <button
      type="button"
      className={[styles.door, wanting ? styles.doorWanting : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/research' })}
      data-track="observatory-research-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>
          Research
          {failed > 0 ? <span className={styles.doorReady}>{failed} failed</span> : null}
        </span>
        <span className={styles.doorLine}>{line}</span>
      </span>
      <span className={styles.doorSpend}>
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
