import type { TimeSegment } from './habitMath';
import styles from './TimeSelector.module.css';

const SEGMENTS: { key: TimeSegment; label: string }[] = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Midday' },
  { key: 'evening', label: 'Evening' },
];

export interface TimeSelectorProps {
  value: TimeSegment;
  onChange: (segment: TimeSegment) => void;
}

/** Morning/Midday/Evening segment picker — port of #time-selector in the old
 * dashboard. Auto-defaults to pickTimeSegment(server_hour) but the user can
 * override for the session (see HabitsColumn). */
export function TimeSelector({ value, onChange }: TimeSelectorProps) {
  return (
    <div className={styles.selector} role="tablist" aria-label="Time of day">
      {SEGMENTS.map((s) => (
        <button
          key={s.key}
          type="button"
          role="tab"
          aria-selected={value === s.key}
          className={`${styles.btn} ${styles[s.key]} ${value === s.key ? styles.active : ''}`}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
