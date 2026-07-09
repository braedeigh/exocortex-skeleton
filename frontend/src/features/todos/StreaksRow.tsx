import type { Streak } from '../habits/types';
import styles from './StreaksRow.module.css';

export interface StreaksRowProps {
  streaks: Streak[];
  onOpen: (streak: Streak) => void;
}

/**
 * "Day N <label>" counters — port of renderStreaks (core.js ~460).
 *
 * Each chip opens its detail sheet (notes + started date + delete — see
 * StreakSheet.tsx), like the old chip body's openStreakDetail.
 * TODO(habits phase 2): the inline "+ day count" add form
 * (addStreak, POST /api/streaks/add) is still streak management left with
 * the habits work.
 */
export function StreaksRow({ streaks, onOpen }: StreaksRowProps) {
  if (!streaks.length) return null;

  return (
    <div className={styles.row}>
      {streaks.map((s) => (
        <button
          type="button"
          className={styles.chip}
          key={`${s.label}-${s.since}`}
          title="Notes & details"
          onClick={() => onOpen(s)}
        >
          <span className={styles.num}>Day {s.days}</span> {s.label}
        </button>
      ))}
    </div>
  );
}
