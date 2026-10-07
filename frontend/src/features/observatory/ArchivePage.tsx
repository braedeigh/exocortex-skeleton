import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ALL_LANES,
  laneLabel,
  toLane,
  useArchiveList,
  type ArchivedSession,
  type Lane,
  type SearchIn,
} from './api';
import { SearchInToggle, SearchNotes, SearchResultRow, useChatSearch } from './ChatFinder';
import { sessionLocation } from './sessionLocation';
import styles from './ArchivePage.module.css';
import { isStandalone } from '../../shell/standalone';
import { useRooms } from './roomsApi';

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
 * THE SEARCH IS THE SAME ONE THE ROSTER'S BOX RUNS. The hook, the Said / Did
 * chips and the result rows all come from ChatFinder.tsx, so a search reads
 * the same here as at the top of the Observatory; this page adds the room
 * scope on top. Plain words, no syntax needed: she's reaching for something
 * she half-remembers, so a half-typed word finds the whole one (rules in
 * chatsearch.py).
 *
 * Reads GET /api/observatory/atlas (the listing, archived included) and GET
 * /api/observatory/search (routes/chat_search.py). Tapping anything opens
 * that session through the same navigation the roster uses.
 */

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

export function ArchivePage({ lane }: { lane?: string }) {
  const navigate = useNavigate();
  const { data: listing, isLoading, isError } = useArchiveList();

  // '' = every room. A lane the client doesn't know falls to '' rather than to
  // an empty page — a bad URL should widen the view, never blank it.
  // The rooms the chips offer: every lane on the site (a retired room's
  // history is still reachable here), the person's own rooms in the desktop app.
  const rooms = useRooms();
  const scopeChoices: Lane[] = isStandalone() ? rooms.map((room) => room.id) : ALL_LANES;
  const scope: Lane | '' = lane && scopeChoices.includes(lane as Lane) ? (lane as Lane) : '';
  // The scope lives in the URL, not in state: the door under each room IS a
  // link to a scoped archive, so back/forward and a shared link all behave.
  const setScope = (next: Lane | '') =>
    void navigate({ to: '/observatory/archive', search: next ? { lane: next } : {}, replace: true });
  const inScope = <T extends { lane?: Lane }>(rows: T[]) =>
    scope ? rows.filter((r) => toLane(r.lane) === scope) : rows;

  const [typed, setTyped] = useState('');
  const [where, setWhere] = useState<SearchIn>('said');
  const search = useChatSearch(typed, where);
  const results = search.results;

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

  const searchingMode = search.searchingMode;
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
            Past sessions{scope ? <span className={styles.titleScope}> · {laneLabel(scope)}</span> : null}
          </h1>
        </div>

        {/* Switch rooms, or widen to all, without going back to the roster.
            Reads ALL_LANES — every lane that exists, not just the ones with a
            room on the roster — so a new room can't appear and silently have no
            archive, and a RETIRED one (Orchestra) doesn't take its history off
            the record when its room goes. This chip row is the only way left to
            reach what Orchestra held. */}
        <div className={styles.scopeRow} role="group" aria-label="Which room">
          {(['', ...scopeChoices] as (Lane | '')[]).map((l) => (
            <button
              key={l || 'all'}
              type="button"
              className={[styles.scopeChip, scope === l ? styles.scopeChipOn : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={scope === l}
              onClick={() => setScope(l)}
            >
              {l ? laneLabel(l) : 'All rooms'}
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
              scope ? `Search everything said in ${laneLabel(scope)}…` : 'Search everything ever said…'
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
            <SearchInToggle value={where} onChange={setWhere} />
            {/* A scoped search that finds nothing must never be a dead end. The
                server searched every room; if the words exist somewhere else,
                say so and offer the one tap that shows them — otherwise she'd
                conclude the thing she remembers saying isn't in the record. */}
            {!search.searching && results && shownResults.length === 0 && results.length > 0 ? (
              <button type="button" className={styles.widen} onClick={() => setScope('')}>
                Nothing in {laneLabel(scope as Lane)} — but {results.length}{' '}
                {results.length === 1 ? 'session' : 'sessions'} elsewhere{' '}
                {results.length === 1 ? 'has' : 'have'} it. Show all rooms →
              </button>
            ) : (
              <SearchNotes state={search} shown={shownResults.length} where={where} />
            )}
            {shownResults.map((r) => (
              <SearchResultRow key={r.id} result={r} where={where} onOpen={open} />
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
                      <span className={styles.chip}>{laneLabel(toLane(s.lane))}</span>
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
