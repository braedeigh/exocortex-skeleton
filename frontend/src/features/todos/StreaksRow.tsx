import type { Streak } from '../habits/types';
import styles from './StreaksRow.module.css';

export interface StreaksRowProps {
  streaks: Streak[];
}

/**
 * "Day N <label>" counters — port of renderStreaks (core.js ~460).
 *
 * Read-only for now: the old chip body opens a detail modal (edit notes,
 * link to a tracked habit) and there's an inline "+ day count" add form —
 * both are streak *management* UI, not the daily habits view this phase
 * covers, so they're deferred.
 * TODO(habits phase 2): openStreakDetail (edit notes + habit linkage),
 * addStreak / removeStreak (POST /api/streaks/add, /api/streaks/update).
 */
export function StreaksRow({ streaks }: StreaksRowProps) {
  if (!streaks.length) return null;

  return (
    <div className={styles.row}>
      {streaks.map((s) => (
        <span className={styles.chip} key={`${s.label}-${s.since}`}>
          <span className={styles.num}>Day {s.days}</span> {s.label}
        </span>
      ))}
    </div>
  );
}
