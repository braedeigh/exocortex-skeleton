/**
 * The journal's search box, in the top bar beside the date, with its ⚙
 * button for the filter row (SearchFilterRow.tsx).
 *
 * Typing puts the journal into search mode: after a short pause the words
 * go into the page address (`/journal?q=…`), and JournalPage swaps the day
 * for the results. Clearing the box, with × or Escape, leaves search mode
 * and brings back the day you were on.
 *
 * Touches: `JournalHeader.tsx` (where it sits), `JournalPage.tsx` (which
 * owns the address and decides what the pane shows).
 *
 * Prompt: "i want it to be like a search bar up at the top next to the date,
 * but maybe with a button to do advanced search."
 */
import { useEffect, useRef, useState } from 'react';
import styles from './JournalSearchBar.module.css';

// How long typing has to pause before the search runs.
const SEARCH_PAUSE_MS = 300;

export interface JournalSearchBarProps {
  /** The search in the page address ('' when not searching). */
  query: string;
  onQueryChange: (query: string) => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  /** How many filters are on, shown as a dot on ⚙ when the row is closed. */
  activeFilterCount: number;
}

export function JournalSearchBar({ query, onQueryChange, filtersOpen, onToggleFilters, activeFilterCount }: JournalSearchBarProps) {
  const [typed, setTyped] = useState(query);
  // The last words this box itself sent up, so an address change that came
  // from somewhere else (tapping "open day" clears the search) can be told
  // apart from our own debounced text coming back around.
  const lastSent = useRef(query);

  // Follow the address when something else changes it.
  useEffect(() => {
    if (query !== lastSent.current) {
      lastSent.current = query;
      setTyped(query);
    }
  }, [query]);

  // Wait for a pause in typing before searching — this is a debounce. Each
  // keystroke restarts the clock, so "bartending" sends one search, not ten.
  useEffect(() => {
    const trimmed = typed.trim();
    if (trimmed === lastSent.current) return;
    const timer = window.setTimeout(() => {
      lastSent.current = trimmed;
      onQueryChange(trimmed);
    }, SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, onQueryChange]);

  // Clear right away, with no pause: leave search mode.
  function clear() {
    setTyped('');
    lastSent.current = '';
    onQueryChange('');
  }

  return (
    <div className={styles.bar}>
      <div className={styles.field}>
        <span className={styles.icon} aria-hidden="true">
          &#128269;
        </span>
        <input
          type="search"
          className={styles.input}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear();
          }}
          placeholder="Search journal"
          aria-label="Search the journal"
          enterKeyHint="search"
          data-track="journal-search-input"
        />
        {typed ? (
          <button type="button" className={styles.clear} onClick={clear} aria-label="Clear search" data-track="journal-search-clear">
            &times;
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className={`${styles.filtersButton} ${filtersOpen ? styles.filtersOn : ''}`}
        onClick={onToggleFilters}
        aria-label="Search filters"
        aria-expanded={filtersOpen}
        title="Search filters"
        data-track="journal-search-filters"
      >
        &#9881;
        {!filtersOpen && activeFilterCount > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
