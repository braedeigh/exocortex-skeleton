/**
 * The journal search's filters: a row that opens under the top bar when ⚙
 * is tapped. Narrows the search to who said it (you, the Keeper, or the
 * system's reminders) and to a
 * range of days. Every change goes straight into the page address, like the
 * search words do, so back/forward and bookmarks keep them.
 *
 * Touches: `JournalSearchBar.tsx` (the ⚙ that opens this),
 * `JournalPage.tsx` (owns the address).
 */
import type { SearchFilters, SearchWho } from './types';
import styles from './SearchFilterRow.module.css';

const WHO_CHOICES: { value: SearchWho; label: string }[] = [
  { value: '', label: 'Everyone' },
  { value: 'B', label: 'Me' },
  { value: 'K', label: 'Keeper' },
  { value: 'S', label: 'System' },
];

export interface SearchFilterRowProps {
  filters: SearchFilters;
  onChange: (next: Partial<SearchFilters>) => void;
}

export function SearchFilterRow({ filters, onChange }: SearchFilterRowProps) {
  const anyOn = Boolean(filters.who || filters.from || filters.to);

  return (
    <div className={styles.row}>
      <div className={styles.group} role="group" aria-label="Who said it">
        {WHO_CHOICES.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={`${styles.chip} ${filters.who === choice.value ? styles.chipOn : ''}`}
            aria-pressed={filters.who === choice.value}
            onClick={() => onChange({ who: choice.value })}
            data-track="journal-search-who"
          >
            {choice.label}
          </button>
        ))}
      </div>

      <div className={styles.group}>
        <label className={styles.dateLabel}>
          From
          <input
            type="date"
            className={styles.date}
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => onChange({ from: e.target.value })}
            data-track="journal-search-from"
          />
        </label>
        <label className={styles.dateLabel}>
          To
          <input
            type="date"
            className={styles.date}
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => onChange({ to: e.target.value })}
            data-track="journal-search-to"
          />
        </label>
      </div>

      {anyOn ? (
        <button
          type="button"
          className={styles.reset}
          onClick={() => onChange({ who: '', from: '', to: '' })}
          data-track="journal-search-filters-reset"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
