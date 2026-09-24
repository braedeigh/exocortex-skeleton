/**
 * The journal's search box: a sheet where you type words and get back every
 * journal card that says them, best match first, with the matching words in
 * bold. Tapping a result closes the sheet and jumps to that card on its day.
 *
 * Keyword search only. Matching the meaning of a question rather than its
 * words is a planned later phase. The query rules (quoted phrases, -words,
 * word*) and the ranking live server-side in `cardsearch.py`; this file only
 * sends what was typed and draws what comes back.
 *
 * Touches: `useJournalData.ts` (useJournalSearch, which calls
 * GET /api/journal/search), `JournalPage.tsx` (opens this and does the jump).
 *
 * Prompt: "i want a manual search tool to be able to search through my
 * journal ... at first just a plain search word feature"
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Button, Sheet } from '../../ui';
import type { SearchHit, SearchSort, SearchWho } from './types';
import { useJournalSearch } from './useJournalData';
import styles from './SearchSheet.module.css';

// How long typing has to pause before a search is sent.
const SEARCH_PAUSE_MS = 300;

const WHO_CHOICES: { value: SearchWho; label: string }[] = [
  { value: '', label: 'Everyone' },
  { value: 'B', label: 'Me' },
  { value: 'K', label: 'Keeper' },
];

const SORT_CHOICES: { value: SearchSort; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

export interface SearchSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (hit: SearchHit) => void;
}

/** "Thu, Sep 18, 2026 · 5:46 PM" from a card's day + "YYYY-MM-DD HH:MM:SS" ts. */
function formatWhen(day: string, ts: string | null): string {
  const date = new Date(`${day}T12:00:00`);
  const dayLabel = Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const clock = ts?.slice(11, 16);
  if (!clock) return dayLabel;
  const [hours, minutes] = clock.split(':').map(Number);
  const time = new Date(2000, 0, 1, hours, minutes).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel} · ${time}`;
}

export function SearchSheet({ open, onClose, onPick }: SearchSheetProps) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [who, setWho] = useState<SearchWho>('');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Wait for a pause in typing before searching — this is a debounce. Each
  // keystroke restarts the clock, so "bartending" sends one search, not ten.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // Put the cursor in the box each time the sheet opens. The words and
  // results from last time stay, so reopening picks up where she left off.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.select());
  }, [open]);

  const search = useJournalSearch(query, who, sort);
  const pages = search.data?.pages ?? [];
  const hits = pages.flatMap((page) => page.hits);
  const total = pages[0]?.total ?? 0;

  // Say what state the search is in, above the list.
  let status: string | null = null;
  if (!query) status = null;
  else if (search.isError)
    status =
      search.error instanceof ApiError && search.error.status === 400
        ? 'Add a word to look for — a search can’t be only -words.'
        : 'Search failed. Try again in a moment.';
  else if (search.isPending) status = 'Searching…';
  else if (total === 0) status = 'No entries match.';
  else status = total === 1 ? '1 entry' : `${total} entries`;

  return (
    <Sheet open={open} onClose={onClose} title="Search the journal">
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="Words to find"
        aria-label="Search the journal"
        enterKeyHint="search"
        data-track="journal-search-input"
      />

      <div className={styles.choices} role="group" aria-label="Who said it">
        {WHO_CHOICES.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={`${styles.chip} ${who === choice.value ? styles.chipOn : ''}`}
            aria-pressed={who === choice.value}
            onClick={() => setWho(choice.value)}
            data-track="journal-search-who"
          >
            {choice.label}
          </button>
        ))}
      </div>
      <div className={styles.choices} role="group" aria-label="Order">
        {SORT_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={`${styles.chip} ${sort === choice.value ? styles.chipOn : ''}`}
            aria-pressed={sort === choice.value}
            onClick={() => setSort(choice.value)}
            data-track="journal-search-sort"
          >
            {choice.label}
          </button>
        ))}
      </div>

      {!query ? (
        <div className={styles.help}>
          Every word you type has to appear. Endings don&apos;t matter — <b>bartending</b> finds{' '}
          <b>bartender</b> too. Use <b>&quot;quotes&quot;</b> for an exact phrase, <b>-word</b> to leave
          entries out, and <b>word*</b> for anything starting with it.
        </div>
      ) : (
        <div className={styles.status} aria-live="polite">
          {status}
        </div>
      )}

      {query && !search.isError ? (
        <ul className={`${styles.results} ${search.isPlaceholderData ? styles.stale : ''}`}>
          {hits.map((hit) => (
            <li key={hit.id}>
              <button type="button" className={styles.hit} onClick={() => onPick(hit)} data-track="journal-search-open">
                <span className={styles.when}>
                  {formatWhen(hit.day, hit.ts)}
                  {hit.who === 'K' ? <span className={styles.keeper}> · Keeper</span> : null}
                </span>
                <span className={styles.excerpt}>
                  {hit.snippet.map((piece, i) =>
                    piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>,
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {search.hasNextPage ? (
        <Button
          variant="secondary"
          fullWidth
          onClick={() => void search.fetchNextPage()}
          disabled={search.isFetchingNextPage}
          data-track="journal-search-more"
        >
          {search.isFetchingNextPage ? 'Loading…' : `Show more (${total - hits.length} left)`}
        </Button>
      ) : null}
    </Sheet>
  );
}
