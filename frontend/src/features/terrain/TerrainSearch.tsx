import { useEffect, useRef, useState } from 'react';
import type { TerrainSearchHit } from './terrainSearch';
import styles from './TerrainSearch.module.css';

/**
 * TerrainSearch — the search field in the Terrain top bar and the hit list
 * that drops from it. Type a name or a bit of a path and the map dims to the
 * files that match (TerrainPage does the lighting through the same spotlight
 * an agent tap uses); this component only owns the field, the list, and the
 * keys. Tap a row, or the lit dot itself, and the file opens in the code
 * pane beside the map (FileCodeWindow).
 *
 * Keys: `/` anywhere on the page focuses the field. ↑/↓ walk the list, Enter
 * opens the highlighted hit (the top one if none is), Esc clears the query,
 * and a second Esc leaves the field. The rows swallow mousedown so the
 * field doesn't blur (and close the list) before the click lands.
 *
 * The matching itself lives in terrainSearch.ts.
 */
export function TerrainSearch({
  query,
  onQuery,
  hits,
  onPick,
}: {
  query: string;
  onQuery: (q: string) => void;
  hits: TerrainSearchHit[];
  onPick: (hit: TerrainSearchHit) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // Which row the arrow keys have reached; null = none, so Enter takes the top.
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => setActive(null), [hits]);

  // `/` focuses the field from anywhere that isn't already a text control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (hit: TerrainSearchHit) => {
    onPick(hit);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setActive((cur) => (cur === null ? 0 : Math.min(hits.length - 1, cur + 1)));
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setActive((cur) => (cur === null || cur === 0 ? null : cur - 1));
    } else if (e.key === 'Enter') {
      const hit = hits[active ?? 0];
      if (hit) pick(hit);
    } else if (e.key === 'Escape') {
      if (query) onQuery('');
      else inputRef.current?.blur();
    }
  };

  const open = focused && query.trim().length > 0;
  const lit = query.trim().length > 0;

  return (
    <div className={styles.wrap}>
      <div className={[styles.field, lit ? styles.fieldLit : ''].filter(Boolean).join(' ')}>
        <span className={styles.glyph} aria-hidden="true">
          &#9906;
        </span>
        <input
          ref={inputRef}
          type="search"
          className={styles.input}
          placeholder="Find a file…"
          aria-label="Find a file"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {lit ? (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onQuery('');
              inputRef.current?.focus();
            }}
          >
            &times;
          </button>
        ) : null}
      </div>
      {open ? (
        <div className={styles.pop} role="listbox" aria-label="Matching files">
          {hits.length === 0 ? (
            <div className={styles.none}>Nothing on the map matches.</div>
          ) : (
            hits.map((hit, i) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={active === i}
                className={[styles.row, active === i ? styles.rowActive : ''].filter(Boolean).join(' ')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(hit)}
              >
                <span className={styles.name}>
                  <Marked text={hit.name} start={hit.start - (hit.path.length - hit.name.length)} end={hit.end - (hit.path.length - hit.name.length)} />
                </span>
                <span className={styles.path}>
                  <span className={styles.repo}>{hit.repoName}</span>
                  {/* &lrm; keeps the RTL tail-truncation from dragging leading
                      punctuation to the wrong end (same trick as FileCodeWindow). */}
                  <span className={styles.pathText}>
                    &lrm;
                    <Marked text={hit.path} start={hit.start} end={hit.end} />
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Text with one span bolded. A span outside the text (the match sits in
 * the directory, not the name) just prints the text plain. */
function Marked({ text, start, end }: { text: string; start: number; end: number }) {
  if (start < 0 || end > text.length || start >= end) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className={styles.mark}>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
