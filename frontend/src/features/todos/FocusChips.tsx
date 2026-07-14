import { FRONT_EMOJI } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import type { FocusCounts } from './todoHelpers';
import styles from './FocusChips.module.css';

export interface FocusChipsProps {
  counts: FocusCounts;
  active: string;
  fronts: Front[];
  onChange: (theme: string) => void;
}

export function FocusChips({ counts, active, fronts, onChange }: FocusChipsProps) {
  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={`${styles.chip} ${!active ? styles.active : ''}`}
        onClick={() => onChange('')}
      >
        All
        <span className={styles.count}>{counts.total}</span>
      </button>
      {fronts.map((f) => {
        const c = counts.byTheme[f.id] || 0;
        if (!c && f.id !== active) return null;
        return (
          <button
            type="button"
            key={f.id}
            className={`${styles.chip} ${f.id === active ? styles.active : ''}`}
            onClick={() => onChange(f.id)}
          >
            {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
            <span className={styles.count}>{c}</span>
          </button>
        );
      })}
      {(counts.none > 0 || active === '__none__') && (
        <button
          type="button"
          className={`${styles.chip} ${active === '__none__' ? styles.active : ''}`}
          onClick={() => onChange('__none__')}
        >
          🏷️ Other
          <span className={styles.count}>{counts.none}</span>
        </button>
      )}
    </div>
  );
}
