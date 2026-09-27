import { useNavigate } from '@tanstack/react-router';
import { useWorktreeMap } from './worktreeMapApi';
import { writersNow } from './worktreeMapMath';
import styles from './NightCrew.module.css';

/**
 * WorktreeMapDoor — the roster row, just under the Coding room, that goes to
 * /observatory/worktrees: which agents are working in which copy of the code.
 * Same door shape as Night crew / Helpers (borrows NightCrew.module.css).
 *
 * It carries a census — how many trees have someone writing in them in the
 * last ten minutes, and how many sessions — polled slowly, because it's a
 * glance, not the page. It warms (the doors' "wanting" tint) when two agents
 * are writing in the same tree at once, since that's the one thing here worth
 * interrupting her for.
 */
export function WorktreeMapDoor() {
  const navigate = useNavigate();
  const { data } = useWorktreeMap(600, 30_000);
  const nowMs = Date.now();
  const trees = data?.trees ?? [];
  const busy = trees.filter((t) => writersNow(t, nowMs).length > 0);
  const agents = new Set(busy.flatMap((t) => writersNow(t, nowMs).map((a) => a.conv)));
  const colliding = trees.filter((t) => writersNow(t, nowMs).length >= 2);

  const line = !data
    ? 'Which agents are working in which copy of the code'
    : busy.length === 0
      ? `Nobody writing right now · ${trees.length} trees`
      : `${agents.size} session${agents.size === 1 ? '' : 's'} writing in ${busy.length} of ${trees.length} trees`;

  return (
    <button
      type="button"
      className={[styles.door, colliding.length > 0 ? styles.doorWanting : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/worktrees' })}
      data-track="observatory-worktrees-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>
          Worktrees
          {colliding.length > 0 ? (
            <span className={styles.doorReady}>
              {colliding.length === 1 ? 'two writing in one tree' : `${colliding.length} trees shared`}
            </span>
          ) : null}
        </span>
        <span className={styles.doorLine}>{line}</span>
      </span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
