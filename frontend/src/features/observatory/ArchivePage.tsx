import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ALL_LANES,
  LANE_LABEL,
  searchSessions,
  toLane,
  useArchiveList,
  type ArchivedSession,
  type Lane,
  type SearchHit,
  type SearchResult,
} from './api';
import { sessionLocation } from './sessionLocation';
import styles from './ArchivePage.module.css';

/**
 * /observatory/archive — everything a room has ever held, and a box to find it
 * in.
 *
 * WHY IT'S HERE AND NOT AT /atlas. This is the atlas, ported. The atlas was a
 * shelf map — every session filed under a life front and a domain — and it was
 * correct and she never used it, because it was a page you had to REMEMBER to
 * go to. Her words: "i never use atlas so i'm imagining we port it over into
 * the observatory." So the archive now lives one tap under each ROOM on the
 * roster, and /atlas redirects here.
 *
 * SCOPED TO A ROOM BY DEFAULT (her correction: "within a certain room
 * underneath that room"). Arriving from Coding's door shows Coding's record,
 * because "what did I build last week" and "what did I say last week" are
 * different questions and making her re-narrow by hand every time is the
 * friction that killed the atlas. The room chips at the top widen or switch
 * it; All is always one tap away, never the thing she has to pass through.
 *
 * WHAT SURVIVED THE PORT AND WHAT DIDN'T. The GIST survived — a cached
 * one-line summary of each old session (scripts/sort_bot_chats.py writes them)
 * is the single most useful thing on a card, because a title says what she
 * MEANT to do and a gist says what happened. The SHELVES didn't: front and
 * domain became chips on the row rather than the skeleton of the page. The
 * hierarchy is the part that failed, so the hierarchy is the part that goes;
 * the labels were never the problem.
 *
 * TWO MODES, ONE PAGE. Idle, it's a flat scroll of every session newest-first,
 * cut into months — which is what "scroll around" wants and what a shelf map
 * can't do. Type, and it becomes a list of the sessions that actually say the
 * words, each with the lines that say them. Clear the box and the scroll comes
 * back. No tab, no toggle: the box's contents ARE the mode.
 *
 * SEARCH IS SUBSTRING, NOT A QUERY LANGUAGE. See the route's docstring
 * (routes/observatory.py, observatory_search) — she's reaching for something
 * she half-remembers, which is the worst possible moment to hand her a syntax.
 *
 * Reads GET /api/observatory/atlas (the listing, archived included) and GET
 * /api/observatory/search (the transcripts). Tapping anything opens that
 * session through the same navigation the roster uses.
 */

/** Long enough that she's stopped typing a word, short enough that it still
 * feels like it's keeping up. The scan is server-side over every transcript,
 * so a request per keystroke would be real work thrown away. */
const DEBOUNCE_MS = 250;

function monthOf(iso: string | undefined): string {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function dayOf(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The matched words, marked. The server hands back where the match sits
 * inside the snippet it already trimmed and ellipsised — re-finding the query
 * here would mean reimplementing that trimming in a second language, and the
 * two would drift. */
function Snippet({ hit }: { hit: SearchHit }) {
  const before = hit.text.slice(0, hit.at);
  const match = hit.text.slice(hit.at, hit.at + hit.len);
  const after = hit.text.slice(hit.at + hit.len);
  return (
    <div className={styles.snippet}>
      <span className={styles.who}>{hit.who === 'B' ? 'you' : 'it'}</span>
      <span className={styles.snippetText}>
        {before}
        <mark className={styles.mark}>{match}</mark>
        {after}
      </span>
    </div>
  );
}

export function ArchivePage({ lane }: { lane?: string }) {
  const navigate = useNavigate();
  const { data: listing, isLoading, isError } = useArchiveList();

  // '' = every room. A lane the client doesn't know falls to '' rather than to
  // an empty page — a bad URL should widen the view, never blank it.
  const scope: Lane | '' = lane && ALL_LANES.includes(lane as Lane) ? (lane as Lane) : '';
  // The scope lives in the URL, not in state: the door under each room IS a
  // link to a scoped archive, so back/forward and a shared link all behave.
  const setScope = (next: Lane | '') =>
    void navigate({ to: '/observatory/archive', search: next ? { lane: next } : {}, replace: true });
  const inScope = <T extends { lane?: Lane }>(rows: T[]) =>
    scope ? rows.filter((r) => toLane(r.lane) === scope) : rows;

  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // Debounce her typing into a query, then run exactly one search for it.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(typed.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [typed]);

  // Every in-flight search is abortable, and a superseded one is aborted —
  // otherwise a slow scan for "ho" can land after a fast one for "housing"
  // and overwrite the newer answer with the older.
  const acRef = useRef<AbortController | null>(null);
  useEffect(() => {
    acRef.current?.abort();
    if (query.length < 2) {
      setResults(null);
      setSearching(false);
      setSearchError(false);
      return;
    }
    const ac = new AbortController();
    acRef.current = ac;
    setSearching(true);
    setSearchError(false);
    searchSessions(query, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setResults(res.results);
        setTruncated(res.truncated);
        setSearching(false);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setSearchError(true);
        setSearching(false);
      });
    return () => ac.abort();
  }, [query]);

  // Idle mode: every session, newest first, cut into months. `last_at` is when
  // it was last SAID IN, which is what she'd scroll looking for — `started` is
  // only the fallback for an entry that never got a stamp.
  const months = useMemo(() => {
    const all = listing?.sessions ?? [];
    const list = scope ? all.filter((s) => toLane(s.lane) === scope) : all;
    const out: { label: string; sessions: ArchivedSession[] }[] = [];
    for (const s of list) {
      const label = monthOf(s.last_at || s.started);
      const tail = out[out.length - 1];
      if (tail && tail.label === label) tail.sessions.push(s);
      else out.push({ label, sessions: [s] });
    }
    return out;
  }, [listing, scope]);

  const open = (convId: string) => {
    void navigate(sessionLocation(convId));
  };

  const searchingMode = query.length >= 2;
  // The server searches every room; the narrowing happens here, so the full
  // count is still known and can be offered when the scoped view comes up dry.
  const shownResults = inScope(results ?? []);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <button
            type="button"
            className={styles.back}
            onClick={() => void navigate({ to: '/observatory' })}
          >
            ← Observatory
          </button>
          {/* The room is in the TITLE, not a chip she has to read off a row.
              She got here from one room's door; the page should say which. */}
          <h1 className={styles.title}>
            Past sessions{scope ? <span className={styles.titleScope}> · {LANE_LABEL[scope]}</span> : null}
          </h1>
        </div>

        {/* Switch rooms, or widen to all, without going back to the roster.
            Reads ALL_LANES so a fourth room can't appear on the roster and
            silently have no archive. */}
        <div className={styles.scopeRow} role="group" aria-label="Which room">
          {(['', ...ALL_LANES] as (Lane | '')[]).map((l) => (
            <button
              key={l || 'all'}
              type="button"
              className={[styles.scopeChip, scope === l ? styles.scopeChipOn : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={scope === l}
              onClick={() => setScope(l)}
            >
              {l ? LANE_LABEL[l] : 'All rooms'}
            </button>
          ))}
        </div>

        {/* Sticky, because the whole point of the page is scrolling a long way
            and still being able to reach for the box. */}
        <div className={styles.searchBar}>
          <input
            type="search"
            className={styles.search}
            placeholder={
              scope ? `Search everything said in ${LANE_LABEL[scope]}…` : 'Search everything ever said…'
            }
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          {typed ? (
            <button
              type="button"
              className={styles.clear}
              aria-label="Clear search"
              onClick={() => setTyped('')}
            >
              ×
            </button>
          ) : null}
        </div>

        {searchingMode ? (
          <>
            {searching ? <div className={styles.hint}>Reading transcripts…</div> : null}
            {searchError ? <div className={styles.hint}>Couldn&rsquo;t run that search.</div> : null}
            {/* A scoped search that finds nothing must never be a dead end. The
                server searched every room; if the words exist somewhere else,
                say so and offer the one tap that shows them — otherwise she'd
                conclude the thing she remembers saying isn't in the record. */}
            {!searching && results && shownResults.length === 0 ? (
              results.length > 0 ? (
                <button type="button" className={styles.widen} onClick={() => setScope('')}>
                  Nothing in {LANE_LABEL[scope as Lane]} — but {results.length}{' '}
                  {results.length === 1 ? 'session' : 'sessions'} elsewhere say it. Show all rooms →
                </button>
              ) : (
                <div className={styles.hint}>Nothing said those words.</div>
              )
            ) : null}
            {/* Never a silent cap: if the scan stopped short of every session,
                the page says so rather than passing a partial answer off as
                the whole archive. */}
            {truncated && shownResults.length > 0 ? (
              <div className={styles.hint}>
                Searched the most recent sessions only — there are more further back.
              </div>
            ) : null}
            {shownResults.map((r) => (
              <button key={r.id} type="button" className={styles.row} onClick={() => open(r.id)}>
                <div className={styles.rowTop}>
                  <span className={styles.rowTitle}>{r.title}</span>
                  <span className={styles.rowDate}>{dayOf(r.last_at || r.started)}</span>
                </div>
                <div className={styles.chips}>
                  <span className={styles.chip}>{LANE_LABEL[toLane(r.lane)]}</span>
                  {r.journal ? <span className={styles.chipJournal}>journal</span> : null}
                  {r.archived ? <span className={styles.chip}>closed</span> : null}
                  {r.title_hit && r.hits.length === 0 ? (
                    <span className={styles.chip}>name matches</span>
                  ) : null}
                </div>
                {r.hits.map((h, i) => (
                  <Snippet key={i} hit={h} />
                ))}
              </button>
            ))}
          </>
        ) : (
          <>
            {isLoading ? <div className={styles.hint}>Loading…</div> : null}
            {isError ? <div className={styles.hint}>Couldn&rsquo;t load past sessions.</div> : null}
            {months.map(({ label, sessions }) => (
              <section key={label} className={styles.month}>
                <h2 className={styles.monthLabel}>{label}</h2>
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={styles.row}
                    onClick={() => open(s.id)}
                  >
                    <div className={styles.rowTop}>
                      <span className={styles.rowTitle}>{s.title || s.id}</span>
                      <span className={styles.rowDate}>{dayOf(s.last_at || s.started)}</span>
                    </div>
                    {/* The gist is the reason this page is worth scrolling: a
                        title says what she meant to do, a gist says what
                        actually happened in there. */}
                    {s.gist ? <div className={styles.gist}>{s.gist}</div> : null}
                    <div className={styles.chips}>
                      <span className={styles.chip}>{LANE_LABEL[toLane(s.lane)]}</span>
                      {s.journal ? <span className={styles.chipJournal}>journal</span> : null}
                      {s.archived ? <span className={styles.chip}>closed</span> : null}
                      {s.tags?.map((t) => (
                        <span key={t} className={styles.chip}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
