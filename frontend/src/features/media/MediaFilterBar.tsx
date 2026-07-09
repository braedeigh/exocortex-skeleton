import { countByType, mediaTypeLabel, presentMediaTypes } from './mediaHelpers';
import type { MediaFilterState, MediaItem, MediaSortKey } from './types';
import styles from './MediaFilterBar.module.css';

const SORT_OPTIONS: Array<[MediaSortKey, string]> = [
  ['date', 'Sort: Date added'],
  ['title', 'Sort: Title (A–Z)'],
  ['type', 'Sort: Type'],
];

export interface MediaFilterBarProps {
  /** All items (unfiltered) — chip counts are data-driven. */
  items: MediaItem[];
  filter: MediaFilterState;
  onChange: (next: MediaFilterState) => void;
}

/** Search box + sort select on one line, then All/type count chips — port of
 * media.js _mediaFilterBarHtml. Only types present in the data get a chip. */
export function MediaFilterBar({ items, filter, onChange }: MediaFilterBarProps) {
  const chip = (value: string, label: string) => {
    const active = filter.type === value;
    return (
      <button
        key={value}
        type="button"
        className={`${styles.chip} ${active ? styles.chipActive : ''}`}
        onClick={() => onChange({ ...filter, type: value })}
      >
        {label}
      </button>
    );
  };

  return (
    <>
      <div className={styles.controlsRow}>
        <input
          type="text"
          className={styles.search}
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          placeholder="Search title or author…"
        />
        <select
          className={styles.sort}
          value={filter.sort}
          onChange={(e) => onChange({ ...filter, sort: e.target.value as MediaSortKey })}
        >
          {SORT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.chipRow}>
        {chip('all', `All (${items.length})`)}
        {presentMediaTypes(items).map((t) =>
          chip(t, `${mediaTypeLabel(t)} (${countByType(items, t)})`),
        )}
      </div>
    </>
  );
}
