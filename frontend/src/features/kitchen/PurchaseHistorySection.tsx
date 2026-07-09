import { useState } from 'react';
import { capitalize } from './catalogHelpers';
import {
  buildHistoryRows,
  daysAgoLabel,
  nextHistorySort,
  readHistorySort,
  sortHistoryRows,
  writeHistorySort,
  type HistorySort,
} from './historyHelpers';
import { Section } from './Section';
import type { KitchenData } from './types';
import styles from './kitchen.module.css';

/** Port of the Purchase History sortable spreadsheet (replaced Pantry). */
export function PurchaseHistorySection({ data }: { data: KitchenData }) {
  const [sortMode, setSortMode] = useState<HistorySort>(readHistorySort);

  const rows = sortHistoryRows(
    buildHistoryRows(
      data.kitchen_known_items || {},
      data.kitchen_purchase_counts || {},
      data.kitchen_last_bought || {},
      data.kitchen_safety_tags || {},
    ),
    sortMode,
  );

  function setSort(col: 'name' | 'category' | 'count' | 'last_bought') {
    const next = nextHistorySort(sortMode, col);
    setSortMode(next);
    writeHistorySort(next);
  }

  const curDir = sortMode.endsWith('_desc') ? '↓' : '↑';
  const th = (col: 'name' | 'category' | 'count' | 'last_bought', label: string, right = false) => (
    <th
      onClick={() => setSort(col)}
      style={{
        padding: 8,
        fontSize: 12,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        cursor: 'pointer',
        userSelect: 'none',
        textAlign: right ? 'right' : 'left',
        background: 'var(--card-bg)',
        position: 'sticky',
        top: 0,
        minHeight: 40,
      }}
    >
      {label}
      {sortMode.startsWith(col + '_') ? ` ${curDir}` : ''}
    </th>
  );

  return (
    <Section
      title="Purchase history"
      badge={<span className={styles.muted13}>({rows.length} items)</span>}
    >
      <div className={styles.muted12} style={{ margin: '6px 0 8px' }}>
        Tap column headers to sort.
      </div>
      <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {th('name', 'Item')}
              {th('category', 'Category')}
              {th('count', '#', true)}
              {th('last_bought', 'Last bought')}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((it) => (
                <tr key={it.name}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    {capitalize(it.name)}{' '}
                    {it.safety === 'safe' ? (
                      <span style={{ color: 'var(--green)', fontWeight: 700 }} title="Safe">✓</span>
                    ) : it.safety === 'suspect' ? (
                      <span style={{ color: 'var(--orange)', fontWeight: 700 }} title="Suspect">⚠</span>
                    ) : null}
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                    {it.category}
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
                    {it.count}
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 12, color: it.lastBought ? 'var(--text)' : 'var(--text-muted)' }}>
                    {daysAgoLabel(it.daysSince)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} style={{ padding: 14, fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
                  No catalog items yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
