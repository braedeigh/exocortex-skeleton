import { useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../todos/useTodayData';
import { PersonRow } from './PersonRow';
import {
  SORT_LABELS,
  TIER_LABEL,
  TIER_ORDER,
  UNTAGGED,
  binByRecency,
  computeAllTags,
  filterAndSort,
  nextSort,
  readStoredSort,
  readStoredTags,
  writeStoredSort,
  writeStoredTags,
} from './rosterLogic';
import type { RosterPerson, SortMode } from './types';
import { usePeopleRoster } from './usePeopleRoster';
import styles from './PeoplePage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * The People tab — React port of static/js/people.js + index.html
 * #tab-people. A browsable, filterable, sortable roster over the same
 * Person dicts the deep /person/<slug> page uses. The server just hands
 * over each person's entry dates + latest note (/api/people/roster); all
 * binning/sorting/filtering lives in rosterLogic.ts.
 */
export function PeoplePage() {
  const { data, isLoading, isError } = usePeopleRoster();
  const { toasts, push, dismiss } = useToasts();

  // "now" is a client concept here — computed once at mount, like the old
  // page computed it once at load.
  const [now] = useState(() => new Date());
  const [sort, setSort] = useState<SortMode>(readStoredSort);
  const [tags, setTags] = useState<ReadonlySet<string>>(readStoredTags);
  // id of the one expanded row, or null.
  const [expanded, setExpanded] = useState<string | null>(null);
  const isPublic = isPublicMode();

  const people = useMemo(() => data?.people ?? [], [data]);
  const allTags = useMemo(() => computeAllTags(people), [people]);
  const list = useMemo(() => filterAndSort(people, sort, tags), [people, sort, tags]);
  const groups = useMemo(() => (sort === 'recent' ? binByRecency(list, now) : null), [list, sort, now]);

  function cycleSort() {
    setSort((cur) => {
      const next = nextSort(cur);
      writeStoredSort(next);
      return next;
    });
  }

  function toggleTag(tag: string) {
    setTags((cur) => {
      const next = new Set(cur);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      writeStoredTags(next);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  const rowFor = (p: RosterPerson) => (
    <PersonRow key={p.id} person={p} now={now} expanded={expanded === p.id} onToggle={() => toggleExpanded(p.id)} />
  );

  // Chips (and the roster below) render off whatever data we have — a failed
  // background refetch must not blank a roster that's already in the cache.
  const ready = !!data;

  return (
    <div className={styles.page}>
      <div className={styles.title}>People</div>

      {/* Old page: controls row exists (with its divider) even while empty;
          chips only render once the roster is in and the fetch succeeded. */}
      <div className={styles.controlsRow}>
        {ready ? (
          <>
            <button type="button" className={`${styles.chip} ${styles.sortChip}`} onClick={cycleSort}>
              {SORT_LABELS[sort]}
            </button>
            <div className={styles.chipSep} />
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={tags.has(t) ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                onClick={() => toggleTag(t)}
              >
                #{t}
              </button>
            ))}
            <button
              type="button"
              className={tags.has(UNTAGGED) ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              onClick={() => toggleTag(UNTAGGED)}
            >
              Untagged
            </button>
          </>
        ) : null}
      </div>

      {isLoading ? (
        <div className={styles.loading}>Loading&hellip;</div>
      ) : isError && !data ? (
        <div className={styles.list}>
          <div className={styles.empty}>Sign in to see your people.</div>
        </div>
      ) : (
        <div className={styles.list}>
          {!list.length ? (
            <div className={styles.empty}>No one matches these filters.</div>
          ) : groups ? (
            TIER_ORDER.flatMap((key) =>
              groups[key].length
                ? [
                    <div key={`tier-${key}`} className={styles.tierTitle}>
                      {TIER_LABEL[key]}
                    </div>,
                    ...groups[key].map(rowFor),
                  ]
                : [],
            )
          ) : (
            list.map(rowFor)
          )}
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {!isPublic ? <NotesPill tab="people" onError={push} /> : null}
    </div>
  );
}
