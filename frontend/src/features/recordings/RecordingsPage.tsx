/**
 * RecordingsPage.tsx — the shelf: every recording she's captured, newest first.
 *
 * TWO SEARCHES, kept visibly apart, because conflating them would lie:
 *   - The box at the top filters the CARDS on metadata she can see — title,
 *     tags, notes, source. Instant, local, no server call.
 *   - "Search inside transcripts" is a separate button that asks the server to
 *     grep every transcript body and comes back with ranked snippets. That's a
 *     different question with different answers, and a filtered list that
 *     silently included full-text hits would make "3 of 40" unreadable.
 *
 * A snippet result jumps into the recording with the phrase highlighted and
 * scrolled to — the reason for keeping the transcripts at all is being able to
 * find the one sentence again.
 *
 * Talks to: api.ts (all endpoints), RecordingCard.tsx (one row), NewRecordingForm
 * (the add sheet), routes/recordings.py on the server.
 *
 * Prompt that produced it: "I want to make a place for transcripts and audio
 * recordings. Right now I can only record from my iPhone."
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRecordings, searchRecordings } from './api';
import { filterRecordings, kindLabel, presentKinds } from './recordingHelpers';
import { NewRecordingForm } from './NewRecordingForm';
import { RecordingCard } from './RecordingCard';
import type { Recording, SearchHit } from './types';
import styles from './RecordingsPage.module.css';

export function RecordingsPage() {
  const [items, setItems] = useState<Recording[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [adding, setAdding] = useState(false);

  // Full-text state lives apart from `query` on purpose — see the block comment.
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [jumpTo, setJumpTo] = useState<{ id: string; phrase: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const body = await getRecordings();
      setItems(body.items);
      setKinds(body.kinds);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load recordings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => filterRecordings(items, query, kindFilter), [items, query, kindFilter]);
  const availableKinds = useMemo(() => presentKinds(items), [items]);

  async function runFullText() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError('');
    try {
      const body = await searchRecordings(q);
      setHits(body.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Recordings</h1>
        <button type="button" className={styles.primaryBtn} onClick={() => setAdding(true)}>
          ＋ New
        </button>
      </header>

      <p className={styles.intro}>
        Audio and transcripts, kept together. Either one alone is fine — a transcript
        with no audio, or audio you&apos;ll transcribe later.
      </p>

      <div className={styles.searchRow}>
        <input
          className={styles.search}
          type="search"
          value={query}
          placeholder="Filter by title, tag, note…"
          onChange={(e) => {
            setQuery(e.target.value);
            setHits(null); // typing again invalidates the last full-text answer
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runFullText();
          }}
        />
        <button
          type="button"
          className={styles.secondaryBtn}
          disabled={!query.trim() || searching}
          onClick={() => void runFullText()}
        >
          {searching ? 'Searching…' : 'Search inside transcripts'}
        </button>
      </div>

      {availableKinds.length > 1 ? (
        <div className={styles.chipRow}>
          <button
            type="button"
            className={kindFilter === 'all' ? styles.chipOn : styles.chip}
            onClick={() => setKindFilter('all')}
          >
            All
          </button>
          {availableKinds.map((k) => (
            <button
              key={k}
              type="button"
              className={kindFilter === k ? styles.chipOn : styles.chip}
              onClick={() => setKindFilter(k)}
            >
              {kindLabel(k)}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      {hits ? (
        <section className={styles.hits}>
          <div className={styles.hitsHead}>
            <h2 className={styles.sectionHead}>
              Inside transcripts: {hits.length === 0 ? 'no matches' : `${hits.length} recording${hits.length === 1 ? '' : 's'}`}
            </h2>
            <button type="button" className={styles.linkBtn} onClick={() => setHits(null)}>
              Clear
            </button>
          </div>
          {hits.map((hit) => (
            <div key={hit.id} className={styles.hit}>
              <button
                type="button"
                className={styles.hitTitle}
                onClick={() => setJumpTo({ id: hit.id, phrase: query.trim() })}
              >
                {hit.title} · {hit.count} match{hit.count === 1 ? '' : 'es'}
              </button>
              {hit.snippets.map((s, i) => (
                <p key={i} className={styles.snippet}>
                  {s}
                </p>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      {loading ? <p className={styles.quiet}>Loading…</p> : null}

      {!loading && items.length === 0 ? (
        <p className={styles.empty}>
          Nothing here yet. Tap <b>＋ New</b> to add the first one — you can paste a
          transcript straight in and attach the audio whenever you get it off your phone.
        </p>
      ) : null}

      {!loading && items.length > 0 && visible.length === 0 ? (
        <p className={styles.empty}>No recording matches that filter.</p>
      ) : null}

      {visible.map((rec) => (
        <RecordingCard
          key={rec.id}
          recording={rec}
          initialOpen={jumpTo?.id === rec.id}
          highlight={jumpTo?.id === rec.id ? jumpTo.phrase : undefined}
          onChanged={() => void load()}
        />
      ))}

      {adding ? (
        <NewRecordingForm
          kinds={kinds}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
