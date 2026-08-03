/**
 * SessionMemoryChip.tsx — what one session is holding, right now.
 *
 * Plain English: a small teal number on a session card saying how much memory
 * that session is using at this moment. Teal because that's already what memory
 * means on this page — the hairline under the Observatory title uses the same
 * colour, so the eye learns it once and reads it at both scales.
 *
 * Because every turn is its own `claude -p` process that exits when the reply
 * ends, "has memory" and "is working right now" are the same fact. That's why
 * the ring spins: the chip is already a live-turn indicator, so the motion
 * states what it means instead of leaving her to infer it.
 *
 * THREE STATES, ONE SLOT — they're mutually exclusive, so they share a place
 * beside the session name and can never contradict each other:
 *
 *   queued   purple, hollow, still   in the run queue; no process exists yet
 *   booting  teal ring, no figure    running, but the number hasn't landed
 *   holding  teal ring + the figure  running, and we know what it weighs
 *
 * WHY BOOTING EXISTS. The figure comes from a /proc walk on its own poll, and
 * a process that just exec'd can also round below the 10MB the server reports
 * in — so for the first seconds of a turn there is genuinely no number to
 * show. Rendering nothing there made a working session look idle, which is the
 * one thing this chip is for. The ring is what says "working"; the figure is
 * detail that arrives a moment later.
 *
 * WHY QUEUED IS PURPLE AND NOT ORANGE. Orange on this page means WANTS YOU —
 * approvals, unread, the things that stop until she acts. A queued turn wants
 * nothing from her; it's waiting on the machine. Purple is the alive family
 * (running, recently active), and queued is one rung down it: about to be
 * alive. So it takes the same hue with the life removed — hollow, and it does
 * not spin. Filled and travelling means a turn is moving; outlined and still
 * means it's waiting for room.
 *
 * Talks to: api.ts's useSessionMemory and useQueuedConvIds (one shared poll
 * each for every card on the page), procmem.py behind the first, and the run
 * queue behind the second.
 *
 * Prompt that produced it: "a teal descriptor of the amount of memory a session
 * is using on the session, reflecting the size of memory it's using in real
 * time"; "make the queued be another icon or something in purple or orange".
 */
import { useQueuedConvIds, useSessionMemory } from './api';
import styles from './SessionMemoryChip.module.css';

export function SessionMemoryChip({
  convId,
  /** Is a turn in flight for this session, per the roster? The roster knows
   * this seconds before the /proc walk does, and that gap is the whole reason
   * the booting state exists. */
  running = false,
  /** Whether anything on the page is running — tightens the shared poll so a
   * start is caught quickly instead of up to eight seconds later. */
  live = false,
}: {
  convId: string;
  running?: boolean;
  live?: boolean;
}) {
  const { data } = useSessionMemory(live);
  const { data: queued } = useQueuedConvIds();
  const mb = data?.[convId];

  // Waiting for room. Checked before `running` because a queued turn has no
  // process at all — the roster's flag can lag a refusal by a poll.
  if (!running && queued?.has(convId)) {
    return (
      <span
        className={styles.queued}
        title="Waiting for room — this turn starts when a slot opens"
      >
        queued
      </span>
    );
  }

  if (!mb) {
    // Running, but the figure hasn't landed yet (or the process is still too
    // small to round to anything). The ring alone still tells the truth.
    if (!running) return null;
    return (
      <span className={styles.ring} title="Working now — starting up" aria-label="Working now, starting up">
        <span className={[styles.inner, styles.innerBooting].join(' ')}>···</span>
      </span>
    );
  }

  const label = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

  return (
    <span
      className={styles.ring}
      title={`Working now — holding about ${label} of memory`}
      aria-label={`Working now, holding about ${label} of memory`}
    >
      <span className={styles.inner}>{label}</span>
    </span>
  );
}
