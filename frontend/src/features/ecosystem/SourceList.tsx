/**
 * SourceList.tsx — the card under the map: search, transparency filter chips,
 * the single-item "Show all" banner, and the source rows (port of _ecoList /
 * _ecoRenderFilterChips / _ecoRenderRows). The search box keeps focus across
 * the 5s poll for free — it's a controlled input, never rebuilt.
 */
import { ECO_TX, ECO_TX_ORDER, compareSources, metaLabel, txInfo, txOf } from './axes';
import type { EcoSource, Transparency } from './types';
import styles from './SourceList.module.css';

export interface SourceListProps {
  sources: EcoSource[];
  search: string;
  onSearch: (q: string) => void;
  txFilter: Transparency | '';
  onTxFilter: (k: Transparency | '') => void;
  soloId: string | null;
  onToggleSolo: (id: string) => void;
  canEdit: boolean;
  onEdit: (id: string) => void;
}

export function SourceList({
  sources,
  search,
  onSearch,
  txFilter,
  onTxFilter,
  soloId,
  onToggleSolo,
  canEdit,
  onEdit,
}: SourceListProps) {
  if (!sources.length) {
    return (
      <div className={styles.emptyState}>
        No food sources yet. Tap ＋ Add food, then tap the map to place it.
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  let list = sources.slice();
  if (txFilter) list = list.filter((s) => txOf(s) === txFilter);
  if (q) {
    list = list.filter(
      (s) =>
        (s.name || '').toLowerCase().includes(q) || (s.note || '').toLowerCase().includes(q),
    );
  }
  list.sort(compareSources);

  const countText =
    q || txFilter
      ? `${list.length} of ${sources.length}`
      : `${sources.length} source${sources.length === 1 ? '' : 's'}`;
  const soloSrc = soloId ? sources.find((s) => s.id === soloId) : undefined;

  const chip = (key: Transparency | '', label: string, color: string | null) => (
    <button
      key={key || 'all'}
      type="button"
      className={`${styles.chip} ${txFilter === key ? styles.chipOn : ''}`}
      onClick={() => onTxFilter(key)}
    >
      {color ? <span className={styles.chipDot} style={{ background: color }} /> : null}
      {label}
    </button>
  );

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Sources</span>
        <span className={styles.count}>{countText}</span>
      </div>
      <input
        type="text"
        className={styles.search}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search by name or note…"
      />
      <div className={styles.chips}>
        {chip('', 'All', null)}
        {ECO_TX_ORDER.map((k) => chip(k, ECO_TX[k].label, ECO_TX[k].color))}
      </div>
      {soloSrc ? (
        <div className={styles.soloBanner}>
          <span className={styles.soloText}>
            Showing only <b>{soloSrc.name}</b> on the map
          </span>
          <button type="button" className={styles.soloClear} onClick={() => onToggleSolo(soloSrc.id)}>
            Show all
          </button>
        </div>
      ) : null}
      {list.length ? (
        list.map((s) => {
          const tx = txInfo(s);
          const active = soloId === s.id;
          return (
            <div
              key={s.id}
              className={`${styles.row} ${active ? styles.rowActive : ''}`}
              onClick={() => onToggleSolo(s.id)}
            >
              <span className={styles.rowDot} style={{ background: tx.color }} />
              <div className={styles.rowMain}>
                <div className={styles.rowName}>{s.name}</div>
                {s.note ? <div className={styles.rowNote}>{s.note}</div> : null}
              </div>
              <span className={styles.rowTag}>
                {tx.label}
                <br />
                {metaLabel(s)}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  className={styles.rowEdit}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(s.id);
                  }}
                >
                  Edit
                </button>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className={styles.noMatch}>No sources match.</div>
      )}
    </div>
  );
}
