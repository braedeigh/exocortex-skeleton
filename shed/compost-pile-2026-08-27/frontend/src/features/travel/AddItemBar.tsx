/**
 * AddItemBar — the "put something on this trip" input. Typing searches the
 * pickable sources (archivals + consumables, minus what's already on the
 * trip); tapping a suggestion adds it as a *reference* to that item, while
 * the Add button (or Enter) adds the raw text as a free-text entry — the
 * toothbrush path.
 */
import { useRef, useState } from 'react';
import { filterSuggestions, tripHasItem } from './travelHelpers';
import type { Suggestion } from './travelHelpers';
import type { TravelData, Trip } from './types';
import styles from './travel.module.css';

export interface AddItemBarProps {
  data: TravelData;
  trip: Trip;
  onAdd: (payload: { name: string; source: 'archival' | 'active' | 'text'; ref_id: string; category: string }) => void;
  onDuplicate: (name: string) => void;
}

export function AddItemBar({ data, trip, onAdd, onDuplicate }: AddItemBarProps) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suggestions = focused ? filterSuggestions(data, trip, query) : [];

  function addSuggestion(s: Suggestion) {
    onAdd({ name: s.name, source: s.source, ref_id: s.id, category: s.category });
    setQuery('');
  }

  function addFreeText() {
    const name = query.trim();
    if (!name) return;
    if (tripHasItem(trip, 'text', '', name)) {
      onDuplicate(name);
      return;
    }
    onAdd({ name, source: 'text', ref_id: '', category: '' });
    setQuery('');
  }

  return (
    <div className={styles.addBar}>
      <input
        className={styles.addInput}
        type="text"
        value={query}
        placeholder="Add an item — search your stuff or just type"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setFocused(true);
        }}
        onBlur={() => {
          // Delay so a tap on a suggestion lands before the list unmounts.
          blurTimer.current = setTimeout(() => setFocused(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') addFreeText();
        }}
        enterKeyHint="done"
      />
      <button type="button" className={styles.addBtn} disabled={!query.trim()} onClick={addFreeText}>
        Add
      </button>
      {suggestions.length > 0 ? (
        <div className={styles.suggestions} role="listbox">
          {suggestions.map((s) => (
            <button
              key={`${s.source}:${s.id}`}
              type="button"
              className={styles.suggestionRow}
              // onMouseDown beats the input's delayed blur on desktop; the
              // 150ms grace above covers touch.
              onMouseDown={(e) => {
                e.preventDefault();
                addSuggestion(s);
              }}
            >
              {s.photo ? (
                <img
                  className={styles.suggestionThumb}
                  src={`/archivals/photo/${encodeURIComponent(s.photo)}`}
                  alt=""
                  loading="lazy"
                />
              ) : null}
              <span>{s.name}</span>
              <span className={styles.suggestionMeta}>
                {s.category || (s.source === 'active' ? 'consumable' : '')}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
