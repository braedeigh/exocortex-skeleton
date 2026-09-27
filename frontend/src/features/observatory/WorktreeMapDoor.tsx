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
 *
 * It wears a small drawing, like the Terrain room cards: one trunk forking
 * into three branches (the copies of the code), a ring at each tip (an
 * agent). The drawing is live — as many rings fill in as there are trees with
 * someone writing, up to three.
 *
 * Prompt that produced the drawing: "put it as a button in the observatory
 * with a nice little picture like on the terrain doors page"
 */

/** Branch tips of the drawing, left to right — where the agent rings sit. */
const BRANCH_TIPS: ReadonlyArray<[number, number]> = [
  [10, 9],
  [32, 7],
  [54, 9],
];

/** A trunk forking into worktrees, an agent ring at each tip — filled for the
 * trees someone is writing in right now. */
function WorktreeMotif({ busyCount }: { busyCount: number }) {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3">
        <path d="M32 39 L32 24" opacity="0.9" />
        <path d="M32 24 C 32 16, 12 20, 10 14" opacity="0.55" />
        <path d="M32 24 L32 12" opacity="0.55" />
        <path d="M32 24 C 32 16, 52 20, 54 14" opacity="0.55" />
      </g>
      {BRANCH_TIPS.map(([cx, cy], i) => (
        <g key={cx}>
          <circle cx={cx} cy={cy} r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.9" />
          <circle cx={cx} cy={cy} r="3" fill="currentColor" opacity={i < busyCount ? 0.9 : 0.15} />
        </g>
      ))}
    </svg>
  );
}

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
      <span className={styles.doorMotif}>
        <WorktreeMotif busyCount={busy.length} />
      </span>
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
