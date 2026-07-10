/**
 * SearchCard.tsx — keyword + semantic search over entries and note files.
 * Keyword always works (pure server-side ranking); Semantic lights up once
 * the server has an OpenAI key and degrades to a friendly message until
 * then. Results are imperative (run on demand), not a live query — same as
 * the old page.
 */

import { useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { searchResearch } from './api';
import { KIND_LABEL } from './helpers';
import { useResearchCtx } from './ResearchContext';
import type { SearchHit } from './types';
import styles from './ResearchPage.module.css';

const MODES: [string, string][] = [
  ['keyword', 'Keyword'],
  ['vector', 'Semantic'],
];

export function SearchCard() {
  const { actions } = useResearchCtx();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('keyword');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  async function run(nextMode = mode, nextQ = q) {
    const query = nextQ.trim();
    if (!query) {
      clear();
      return;
    }
    const mySeq = ++seq.current;
    setHits(null);
    setMsg('');
    try {
      const body = await searchResearch(query, nextMode);
      if (seq.current !== mySeq) return;
      setHits(body.hits ?? []);
    } catch (err) {
      if (seq.current !== mySeq) return;
      if (err instanceof ApiError) {
        if (err.status === 404) setMsg('Search API not loaded yet — needs an app restart.');
        else if (err.status === 503) setMsg('Semantic search needs an OpenAI key on the server. Keyword mode works now.');
        else setMsg('Search failed.');
      } else {
        setMsg('Network error — try again.');
      }
    }
  }

  function clear() {
    setHits(null);
    setMsg('');
    setQ('');
  }

  function pickMode(m: string) {
    setMode(m);
    if (q.trim()) void run(m);
  }

  return (
    <div className={styles.composer}>
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          value={q}
          placeholder='Search entries + note files… ("quoted phrase", -exclude)'
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
        />
        <button type="button" className={styles.primaryBtn} onClick={() => void run()}>
          Search
        </button>
      </div>
      <div className={styles.composerChips}>
        {MODES.map(([m, label]) => (
          <button
            type="button"
            key={m}
            className={`${styles.chip} ${mode === m ? styles.chipActive : ''}`}
            onClick={() => pickMode(m)}
          >
            {label}
          </button>
        ))}
        {hits || msg ? (
          <button type="button" className={`${styles.chip} ${styles.chipRight}`} onClick={clear}>
            Clear
          </button>
        ) : null}
      </div>

      {msg ? <div className={styles.searchMsg}>{msg}</div> : null}
      {!msg && hits ? (
        hits.length ? (
          hits.map((h, i) => (
            <div key={`${h.id}-${i}`} className={styles.entry}>
              <div className={styles.entryHead}>
                {h.kind === 'note' ? (
                  <>
                    <span className={`${styles.kind} ${styles.kindNote}`}>&#128196; note file</span>
                    <button type="button" className={styles.hitTitleBtn} onClick={() => actions.openLibraryFile(h.id)}>
                      {h.title || h.id}
                    </button>
                  </>
                ) : (
                  <span
                    className={`${styles.kind} ${
                      h.entry_kind === 'source'
                        ? styles.kindSource
                        : h.entry_kind === 'claim'
                          ? styles.kindClaim
                          : h.entry_kind === 'question'
                            ? styles.kindQuestion
                            : styles.kindNote
                    }`}
                  >
                    {KIND_LABEL[h.entry_kind ?? ''] ?? 'Entry'}
                  </span>
                )}
              </div>
              <div className={styles.hitSnippet}>{h.snippet ?? ''}</div>
              {h.topics && h.topics.length ? (
                <div className={styles.tagRow}>
                  {h.topics.map((n) => (
                    <span key={n} className={`${styles.chip} ${styles.chipStatic}`}>
                      {n}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <div className={styles.searchEmpty}>No matches.</div>
        )
      ) : null}
    </div>
  );
}
