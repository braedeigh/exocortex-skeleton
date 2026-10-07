import { useEffect, useRef, useState } from 'react';
import {
  LANE_LABEL,
  mergeOpenedSessions,
  searchSessions,
  toLane,
  useRecentSessions,
  type RecentSession,
  type SearchHit,
  type SearchIn,
  type SearchResult,
} from './api';
import { openedMap } from './readReceipts';
import styles from './ChatFinder.module.css';

/**
 * ChatFinder.tsx — finding a chat again, from the top of the Observatory.
 *
 * One box and one list. The box searches every session ever held, closed ones
 * included. Under the empty box sits "Recently opened": the sessions she
 * looked at last, newest first, whether they are still open or have closed.
 * Type, and the list gives way to the sessions that match; clear the box and
 * the list comes back. The box's contents ARE the mode, the same rule the
 * Past sessions page follows.
 *
 * The search has two readings, switched by the Said / Did chips: what was SAID
 * in the chats, or what the agents DID (the files they touched, the commands
 * they ran).
 *
 * This file also holds the pieces the Past sessions page (ArchivePage.tsx)
 * shares: the `useChatSearch` hook, the Said / Did chips and the result row.
 *
 * Reads GET /api/observatory/search and GET /api/observatory/recent
 * (routes/chat_search.py). Opening a session is the caller's job (`onOpen`),
 * so the roster's own navigation rules apply.
 *
 * Prompt that produced it: "Need some kind of search function for chats and
 * to be able to see the last ones I had opened in the observatory."
 */

/** Long enough that she's stopped typing a word, short enough that it still
 * feels like it's keeping up. */
const DEBOUNCE_MS = 250;
/** Below this the server answers with nothing: one letter matches everything. */
const MIN_QUERY = 2;
/** How many recently opened sessions show before "Show all". */
const RECENT_SHORT = 5;
const RECENT_LONG = 20;
/** Remembers whether the Recently opened list is folded away. */
const RECENT_FOLD_KEY = 'exo-recent-opened-fold';
/** Set once this browser has handed its own record of opens to the server. */
const HANDED_OVER_KEY = 'exo-opened-handed-over';

function dayOf(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** How long ago she opened a session, in the fewest words: "just now",
 * "12m ago", "3h ago", "yesterday", then the date. */
export function openedAgo(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((nowMs - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'yesterday';
  return dayOf(iso);
}

export interface ChatSearchState {
  /** The query actually being searched: what she typed, trimmed, once she
   * paused. Shorter than MIN_QUERY means "not searching". */
  query: string;
  searchingMode: boolean;
  results: SearchResult[] | null;
  searching: boolean;
  failed: boolean;
  truncated: boolean;
  catchingUp: boolean;
}

/** Run the chat search for whatever is typed in a box.
 *
 * This is a debounce: her typing is turned into a query only once she pauses,
 * then exactly one search runs for it. Every in-flight search is abortable,
 * and a superseded one is aborted, so a slow answer for "ho" can't land after
 * a fast one for "housing" and overwrite it. */
export function useChatSearch(typed: string, where: SearchIn): ChatSearchState {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(typed.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [typed]);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    if (query.length < MIN_QUERY) {
      setResults(null);
      setSearching(false);
      setFailed(false);
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setSearching(true);
    setFailed(false);
    searchSessions(query, where, abort.signal)
      .then((res) => {
        if (abort.signal.aborted) return;
        setResults(res.results);
        setTruncated(res.truncated);
        setCatchingUp(res.catching_up);
        setSearching(false);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setFailed(true);
        setSearching(false);
      });
    return () => abort.abort();
  }, [query, where]);

  return {
    query,
    searchingMode: query.length >= MIN_QUERY,
    results,
    searching,
    failed,
    truncated,
    catchingUp,
  };
}

/** The Said / Did chips: which record the search reads. */
export function SearchInToggle({
  value,
  onChange,
}: {
  value: SearchIn;
  onChange: (next: SearchIn) => void;
}) {
  const options: { key: SearchIn; label: string; title: string }[] = [
    { key: 'said', label: 'Said', title: 'Search what was said in the chats' },
    { key: 'did', label: 'Did', title: 'Search what the agents did: files touched, commands run' },
  ];
  return (
    <div className={styles.inRow} role="group" aria-label="What to search">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={[styles.inChip, value === o.key ? styles.inChipOn : ''].filter(Boolean).join(' ')}
          aria-pressed={value === o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One excerpt, with the matched words marked. The server cut the excerpt and
 * marked the matches; this only draws the pieces. */
function Snippet({ hit }: { hit: SearchHit }) {
  const speaker = hit.who === 'B' ? 'you' : hit.who === 'K' ? 'it' : hit.who;
  const isTool = hit.who !== 'B' && hit.who !== 'K';
  return (
    <div className={styles.snippet}>
      <span className={isTool ? styles.whoTool : styles.who}>{speaker}</span>
      <span className={styles.snippetText}>
        {hit.pieces.map((piece, i) =>
          piece.hit ? (
            <mark key={i} className={styles.mark}>
              {piece.text}
            </mark>
          ) : (
            <span key={i}>{piece.text}</span>
          ),
        )}
      </span>
    </div>
  );
}

/** One session that matched: its name, room and state, then its excerpts.
 * The whole row opens the session. */
export function SearchResultRow({
  result,
  where,
  onOpen,
}: {
  result: SearchResult;
  where: SearchIn;
  onOpen: (convId: string) => void;
}) {
  const more = result.count - result.hits.length;
  return (
    <button type="button" className={styles.row} onClick={() => onOpen(result.id)}>
      <div className={styles.rowTop}>
        <span className={styles.rowTitle}>{result.title}</span>
        <span className={styles.rowDate}>{dayOf(result.last_at || result.started)}</span>
      </div>
      <div className={styles.chips}>
        <span className={styles.chip}>{LANE_LABEL[toLane(result.lane)]}</span>
        {result.journal ? <span className={styles.chipJournal}>journal</span> : null}
        {result.archived ? <span className={styles.chip}>closed</span> : null}
        {result.title_hit && result.hits.length === 0 ? (
          <span className={styles.chip}>name matches</span>
        ) : null}
      </div>
      {result.hits.map((h, i) => (
        <Snippet key={i} hit={h} />
      ))}
      {more > 0 ? (
        <div className={styles.more}>
          + {more} more {where === 'did' ? (more === 1 ? 'call' : 'calls') : more === 1 ? 'line' : 'lines'}
        </div>
      ) : null}
    </button>
  );
}

/** The notes that go with a list of results: still reading, failed, nothing
 * found, cut short, or not fully indexed yet. Never a silent cap: if the
 * answer is partial, the page says so. */
export function SearchNotes({ state, shown, where }: { state: ChatSearchState; shown: number; where: SearchIn }) {
  return (
    <>
      {state.searching && state.results === null ? <div className={styles.hint}>Searching…</div> : null}
      {state.failed ? <div className={styles.hint}>Couldn&rsquo;t run that search.</div> : null}
      {!state.searching && !state.failed && state.results && shown === 0 ? (
        <div className={styles.hint}>
          {where === 'did' ? 'No agent touched anything by that name.' : 'Nothing said those words.'}
        </div>
      ) : null}
      {state.catchingUp ? (
        <div className={styles.hint}>
          Older chats are still being indexed, so this may be missing some. Try again in a minute.
        </div>
      ) : null}
      {state.truncated && shown > 0 ? (
        <div className={styles.hint}>Showing the most recent matches. Add a word to narrow it.</div>
      ) : null}
    </>
  );
}

function RecentRow({ session, onOpen }: { session: RecentSession; onOpen: (convId: string) => void }) {
  return (
    <button type="button" className={styles.recentRow} onClick={() => onOpen(session.id)}>
      <span className={styles.rowTitle}>{session.title}</span>
      <span className={styles.chip}>{LANE_LABEL[toLane(session.lane)]}</span>
      {session.archived ? <span className={styles.chip}>closed</span> : null}
      <span className={styles.rowDate}>{openedAgo(session.opened_at)}</span>
    </button>
  );
}

export function ChatFinder({ onOpen }: { onOpen: (convId: string) => void }) {
  const [typed, setTyped] = useState('');
  const [where, setWhere] = useState<SearchIn>('said');
  const search = useChatSearch(typed, where);
  const { data: recent, refetch } = useRecentSessions(RECENT_LONG);

  // Whether the Recently opened list is folded away, remembered per browser.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(RECENT_FOLD_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleFold = () =>
    setFolded((was) => {
      try {
        localStorage.setItem(RECENT_FOLD_KEY, was ? '0' : '1');
      } catch {
        // storage disabled: the fold just isn't remembered
      }
      return !was;
    });
  const [showAll, setShowAll] = useState(false);

  // Hand this browser's own record of opens to the server, once. The browser
  // has kept "when did I open this" for the unread dots since long before the
  // server kept a list, so this is what makes the list start out full instead
  // of empty.
  useEffect(() => {
    try {
      if (localStorage.getItem(HANDED_OVER_KEY) === '1') return;
      const opened = openedMap();
      if (Object.keys(opened).length === 0) {
        localStorage.setItem(HANDED_OVER_KEY, '1');
        return;
      }
      void mergeOpenedSessions(opened)
        .then(() => {
          localStorage.setItem(HANDED_OVER_KEY, '1');
          void refetch();
        })
        .catch(() => {});
    } catch {
      // storage disabled: nothing to hand over
    }
  }, [refetch]);

  const sessions = recent?.sessions ?? [];
  const shownRecent = showAll ? sessions : sessions.slice(0, RECENT_SHORT);
  const results = search.results ?? [];

  return (
    <div className={styles.finder}>
      <div className={styles.searchBar}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search every chat…"
          aria-label="Search every chat"
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
        />
        {typed ? (
          <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setTyped('')}>
            ×
          </button>
        ) : null}
      </div>

      {search.searchingMode ? (
        <div className={styles.results}>
          <SearchInToggle value={where} onChange={setWhere} />
          <SearchNotes state={search} shown={results.length} where={where} />
          {results.map((r) => (
            <SearchResultRow key={r.id} result={r} where={where} onOpen={onOpen} />
          ))}
        </div>
      ) : sessions.length > 0 ? (
        <section className={styles.recent}>
          <button
            type="button"
            className={styles.recentHead}
            aria-expanded={!folded}
            onClick={toggleFold}
          >
            <span className={styles.chevron} aria-hidden="true">
              {folded ? '▸' : '▾'}
            </span>
            Recently opened
          </button>
          {folded ? null : (
            <>
              {shownRecent.map((s) => (
                <RecentRow key={s.id} session={s} onOpen={onOpen} />
              ))}
              {sessions.length > RECENT_SHORT ? (
                <button type="button" className={styles.showAll} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${sessions.length}`}
                </button>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
