/**
 * SessionMemoryChip.tsx — what one session is holding, right now.
 *
 * Plain English: a small teal number on a session card saying how much memory
 * that session is using at this moment. Teal because that's already what memory
 * means on this page — the hairline under the Observatory title uses the same
 * colour, so the eye learns it once and reads it at both scales.
 *
 * It renders NOTHING unless the session is actually alive. A finished session
 * holds no memory, and a stale figure sitting on a dead card would be a lie —
 * so absent beats invented, the same rule the header meter follows.
 *
 * And because every turn is its own `claude -p` process that exits when the
 * reply ends, "has memory" and "is working right now" are the same fact. That's
 * why the ring spins: the chip is already a live-turn indicator, so the motion
 * states what it means instead of leaving her to infer it.
 *
 * Talks to: api.ts's useSessionMemory (one shared poll for every card on the
 * page) and procmem.py behind it, which walks /proc and attributes each
 * process to the conversation it was spawned for.
 *
 * Prompt that produced it: "a teal descriptor of the amount of memory a session
 * is using on the session, reflecting the size of memory it's using in real
 * time."
 */
import { useSessionMemory } from './api';
import styles from './SessionMemoryChip.module.css';

export function SessionMemoryChip({ convId }: { convId: string }) {
  const { data } = useSessionMemory();
  const mb = data?.[convId];

  // Absent from the map = not running = no chip. Zero is also nothing worth
  // drawing, so it's filtered by the same test.
  if (!mb) return null;

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
