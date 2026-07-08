import { TODO_THEMES } from './todoHelpers';
import type { FocusCounts } from './todoHelpers';
import styles from './FocusChips.module.css';

export interface FocusChipsProps {
  counts: FocusCounts;
  active: string;
  onChange: (theme: string) => void;
}

export function FocusChips({ counts, active, onChange }: FocusChipsProps) {
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
      {TODO_THEMES.map((t) => {
        const c = counts.byTheme[t.key] || 0;
        if (!c && t.key !== active) return null;
        return (
          <button
            type="button"
            key={t.key}
            className={`${styles.chip} ${t.key === active ? styles.active : ''}`}
            onClick={() => onChange(t.key)}
          >
            {t.emoji} {t.label}
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
