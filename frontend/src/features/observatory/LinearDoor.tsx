import { useNavigate } from '@tanstack/react-router';
import type { LinearRoomState } from './api';
import { unseenLinearNews } from './linearNewsSeen';
import styles from './NightCrew.module.css';

/**
 * LinearDoor — the row on the roster that goes to /observatory/linear: the
 * sessions that work in Linear, the outside issue tracker, with her.
 *
 * A DOOR, NOT A ROOM BLOCK, for the same reason as Research: it's a real lane
 * (it fixes where the session stands), but its work is a project of its own,
 * and it would crowd her Personal and Coding conversations. It sits with the
 * Night crew, Helpers and Research doors, in the same shape and styles.
 *
 * Like the other doors it must never go silent. Linear news she hasn't
 * looked at (what someone else did there — linear_feed.py), a running
 * session, or a failure she hasn't seen warms the row and says so. It never
 * navigates for her.
 */
export function LinearDoor({ state }: { state: LinearRoomState | null }) {
  const navigate = useNavigate();
  const sessions = state?.sessions ?? [];
  const running = state?.running ?? 0;
  const failed = state?.failed ?? 0;
  const latest = sessions[0];
  const news = unseenLinearNews(state?.news_times ?? []);

  // One sentence, in order of what asks something of her: news from Linear
  // she hasn't looked at, else a session still going, else a failure she
  // hasn't seen, else the last thing that ran.
  const line =
    news > 0
      ? `${news} new in Linear from someone else`
      : running > 0
      ? `${running} running now`
      : failed > 0
        ? `${failed} failed — worth a look`
        : latest
          ? `Last: ${latest.title || latest.id}`
          : 'Work in Linear together.';

  const wanting = news > 0 || running > 0 || failed > 0;

  return (
    <button
      type="button"
      className={[styles.door, wanting ? styles.doorWanting : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/linear' })}
      data-track="observatory-linear-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>
          Linear
          {news > 0 ? <span className={styles.doorReady}>{news} new</span> : null}
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
