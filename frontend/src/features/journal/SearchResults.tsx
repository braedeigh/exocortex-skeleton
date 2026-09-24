/**
 * The journal pane in search mode: every entry that matches, newest first,
 * drawn as the same cards as a normal day, gathered under a date header per
 * day with an "Open day" button that jumps to that day and flashes the entry.
 *
 * Read-only on purpose: an entry is changed on its own day, not from a list
 * of results. More results load as you scroll near the bottom. Very long
 * entries (the Keeper's day summaries) start folded, with "Show more".
 *
 * Touches: `useJournalData.ts` (useJournalSearch → GET /api/journal/search),
 * `EntryCard.tsx` (each result, read-only, hits lit via searchMarks.ts),
 * `JournalPage.tsx` (shows this instead of the day while searching).
 *
 * Prompt: "i want it to filter like the journal UI, such that everything
 * shows similarly to the cards, but with like a date above it ... i don't
 * want it to be a popup, i want it to be something that automatically shows
 * on the journal pane" — newest first, read only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { EntryCard } from './EntryCard';
import type { EntityMatcher } from './entityHighlight';
import type { Card, SearchFilters, SearchHit } from './types';
import { useJournalSearch } from './useJournalData';
import styles from './SearchResults.module.css';

// An entry longer than this (in characters) starts folded.
const FOLD_OVER_CHARS = 1200;

export interface SearchResultsProps {
  filters: SearchFilters;
  matcher: EntityMatcher;
  threadNames: ReadonlyMap<string, string>;
  counterNames: ReadonlyMap<string, string>;
  onOpenThread: (slug: string) => void;
  onOpenCounter: (tag: string) => void;
  /** Leave search and land on this entry in its day. */
  onOpenDay: (date: string, cardId: string) => void;
}

/** "Thursday, September 18, 2026" — display only. */
function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** A search hit in the shape EntryCard draws. */
function hitToCard(hit: SearchHit): Card {
  return {
    id: hit.id,
    who: hit.who,
    ts: hit.ts ?? '',
    tags: hit.tags,
    kind: hit.kind ?? '',
    body: '',
    refs: [],
  };
}

/** Consecutive hits on the same day, as one group — the results come newest
 * first, so each day's entries are already side by side. */
function groupByDay(hits: SearchHit[]): { day: string; hits: SearchHit[] }[] {
  const groups: { day: string; hits: SearchHit[] }[] = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last.day === hit.day) last.hits.push(hit);
    else groups.push({ day: hit.day, hits: [hit] });
  }
  return groups;
}

const noop = () => {};

export function SearchResults({
  filters,
  matcher,
  threadNames,
  counterNames,
  onOpenThread,
  onOpenCounter,
  onOpenDay,
}: SearchResultsProps) {
  const search = useJournalSearch(filters);
  const hits = useMemo(() => (search.data?.pages ?? []).flatMap((page) => page.hits), [search.data]);
  const total = search.data?.pages[0]?.total ?? 0;
  const groups = useMemo(() => groupByDay(hits), [hits]);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());

  // Load the next page when the bottom comes into view — an infinite scroll.
  // The sentinel is an empty div after the last card; the observer fires as
  // it nears the screen (600px early, so the next page is usually already
  // there by the time she reaches it).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, groups.length]);

  // Say what state the search is in, above the results.
  let summary: string;
  if (search.isError)
    summary =
      search.error instanceof ApiError && search.error.status === 400
        ? 'Add a word to look for — a search can’t be only -words.'
        : 'Search failed. Try again in a moment.';
  else if (search.isPending) summary = 'Searching…';
  else if (total === 0) summary = `No entries match “${filters.q}”.`;
  else summary = `${total === 1 ? '1 entry' : `${total} entries`} for “${filters.q}”`;

  return (
    <div className={`${styles.results} ${search.isPlaceholderData ? styles.stale : ''}`}>
      <div className={styles.summary} aria-live="polite">
        {summary}
      </div>

      {search.isError
        ? null
        : groups.map((group) => (
            <section key={group.day} className={styles.day}>
              <div className={styles.dayHeader}>
                <h2 className={styles.dayTitle}>{formatDay(group.day)}</h2>
                <button
                  type="button"
                  className={styles.openDay}
                  onClick={() => onOpenDay(group.day, group.hits[0].id)}
                  data-track="journal-search-open-day"
                >
                  Open day &rarr;
                </button>
              </div>
              {group.hits.map((hit) => {
                const folded = hit.marked_body.length > FOLD_OVER_CHARS && !unfolded.has(hit.id);
                return (
                  <div key={hit.id}>
                    <div className={folded ? styles.folded : undefined}>
                      <EntryCard
                        card={hitToCard(hit)}
                        markedBody={hit.marked_body}
                        readOnly
                        editing={false}
                        saving={false}
                        matcher={matcher}
                        onEdit={noop}
                        onCancel={noop}
                        onSave={noop}
                        onConfirmDelete={noop}
                        threadNames={threadNames}
                        onOpenThread={onOpenThread}
                        counterNames={counterNames}
                        onOpenCounter={onOpenCounter}
                      />
                    </div>
                    {hit.marked_body.length > FOLD_OVER_CHARS ? (
                      <button
                        type="button"
                        className={styles.foldToggle}
                        onClick={() =>
                          setUnfolded((current) => {
                            const next = new Set(current);
                            if (next.has(hit.id)) next.delete(hit.id);
                            else next.add(hit.id);
                            return next;
                          })
                        }
                        data-track="journal-search-fold"
                      >
                        {folded ? 'Show more' : 'Show less'}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}

      <div ref={sentinelRef} />
      {isFetchingNextPage ? <div className={styles.summary}>Loading more…</div> : null}
    </div>
  );
}
