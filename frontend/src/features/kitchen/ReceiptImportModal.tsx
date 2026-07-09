import { useState } from 'react';
import { importParsedReceipt } from './api';
import { Modal } from './Modal';
import {
  buildLearnRules,
  countConfirmed,
  locationOptions,
  locationValue,
  parseLocationVal,
  rowIsSorted,
  snapRowToCatalog,
  suggestCatalogName,
} from './receiptHelpers';
import type { KitchenData, ReceiptHeader, ReceiptRow } from './types';
import styles from './kitchen.module.css';

const NEW_ITEM = '__new__';
const NEW_SECTION = '__new_section__';

export interface ReceiptImportModalProps {
  filename: string;
  header: ReceiptHeader;
  initialRows: ReceiptRow[];
  data: KitchenData;
  onClose: () => void;
  onImported: () => void;
  onError: (message: string) => void;
  /** prompt-and-create a new section (category) */
  createCategoryNamed: (raw: string) => Promise<string | null>;
}

/** Port of #receipt-import-modal — every row must be confirmed (tap it or edit
 * any field) before the orange highlight clears; Import writes the trip,
 * learned rules, and (optionally) the pantry. */
export function ReceiptImportModal({
  filename,
  header,
  initialRows,
  data,
  onClose,
  onImported,
  onError,
  createCategoryNamed,
}: ReceiptImportModalProps) {
  const [rows, setRows] = useState<ReceiptRow[]>(initialRows);
  const [updatePantry, setUpdatePantry] = useState(true);
  /** New catalog items minted inside this modal (they aren't on the server
   * yet, so the dropdowns merge them with the live catalog). */
  const [localCatalog, setLocalCatalog] = useState<Record<string, string>>({});

  const known = { ...(data.kitchen_known_items || {}), ...localCatalog };
  const aislesMap = data.kitchen_aisles || {};
  const categoryOrder = data.kitchen_category_order || [];
  const catalogNames = Object.keys(known).sort();
  const locOpts = locationOptions(categoryOrder);

  const { sorted, total, allConfirmed } = countConfirmed(rows);

  function patchRow(i: number, patch: Partial<ReceiptRow>) {
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch, user_touched: true } : r)));
  }

  function onCatalogPick(i: number, value: string) {
    const row = rows[i];
    if (value === NEW_ITEM) {
      const guess = suggestCatalogName(row.name);
      const name = (window.prompt('New catalog item name (lowercase, canonical — e.g. "broccoli" not "HEB ORG BROCCOLI"):', guess) || '')
        .trim()
        .toLowerCase();
      if (!name) return;
      const category = (row.category || 'other').toLowerCase();
      setLocalCatalog((cur) => ({ ...cur, [name]: category }));
      patchRow(i, { catalog_name: name, category });
      return;
    }
    setRows((cur) => cur.map((r, idx) => (idx === i ? snapRowToCatalog(r, value, known, aislesMap) : r)));
  }

  async function onLocationPick(i: number, value: string) {
    if (value === NEW_SECTION) {
      const name = await createCategoryNamed(
        window.prompt('New section name? (e.g. "frozen", "bulk", "bakery")') || '',
      );
      if (!name) return;
      patchRow(i, { category: name, aisle: null });
      return;
    }
    const { category, aisle } = parseLocationVal(value);
    patchRow(i, { category, aisle });
  }

  async function submit() {
    const learnRules = buildLearnRules(rows);
    try {
      const res = await importParsedReceipt(filename, rows, learnRules, updatePantry);
      if (res?.error) {
        onError(res.error);
        return;
      }
      onImported();
      onClose();
    } catch (e) {
      onError(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const totalStr = header.total ? `$${Number(header.total).toFixed(2)}` : '—';
  const savedStr = header.saved ? ` · saved $${Number(header.saved).toFixed(2)}` : '';

  return (
    <Modal
      title={`${header.store || 'Receipt'} · ${header.date || ''}`}
      onClose={onClose}
      size="tall"
      footer={
        <>
          <label className={styles.muted12} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, cursor: 'pointer' }}>
            <input type="checkbox" checked={updatePantry} onChange={(e) => setUpdatePantry(e.target.checked)} />
            Add to pantry
          </label>
          <button type="button" className={styles.mutedBtn} style={{ marginLeft: 'auto' }} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.greenBtn} onClick={() => void submit()}>
            Import trip
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 8 }}>
        {rows.length} line items · total {totalStr}
        {savedStr}
      </div>
      <div className={styles.rowFlex} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, flex: 1, color: allConfirmed ? 'var(--green)' : '#e8741c' }}>
          {allConfirmed
            ? `✓ All ${total} confirmed — ready to import`
            : `${sorted} / ${total} confirmed — tap each row to confirm (or edit anything to mark it touched)`}
        </div>
        <button
          type="button"
          className={styles.primaryBtn}
          style={{ fontSize: 12, padding: '6px 14px', minHeight: 40, opacity: allConfirmed ? 0.6 : 1 }}
          disabled={allConfirmed}
          onClick={() => setRows((cur) => cur.map((r) => ({ ...r, user_touched: true })))}
        >
          {allConfirmed ? '✓ All confirmed' : 'Approve all'}
        </button>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 4, background: 'var(--bg)' }}>
        {rows.map((r, i) => {
          const priceStr = r.price ? `$${Number(r.price).toFixed(2)}` : '';
          const qty = Number(r.qty) || 1;
          const isSorted = rowIsSorted(r);
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => patchRow(i, {})}
              onKeyDown={(e) => {
                if (e.key === 'Enter') patchRow(i, {});
              }}
              style={{
                padding: '8px 6px 8px 10px',
                borderBottom: '1px solid var(--border)',
                fontSize: 13,
                cursor: 'pointer',
                background: isSorted ? 'var(--card-bg)' : 'rgba(255,140,40,0.18)',
                borderLeft: isSorted ? '4px solid transparent' : '4px solid #e8741c',
                opacity: r.include ? 1 : 0.45,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={r.include}
                  title="Include this item in the imported trip — uncheck to skip"
                  style={{ margin: '3px 0 0', flexShrink: 0, width: 20, height: 20 }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patchRow(i, { include: e.target.checked })}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>
                    {qty > 1 ? (
                      <span
                        style={{
                          background: 'var(--green)',
                          color: '#fff',
                          padding: '1px 6px',
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          marginRight: 4,
                        }}
                      >
                        ×{qty}
                      </span>
                    ) : null}
                    {r.name}
                  </div>
                  <div className={styles.muted12} style={{ marginTop: 1 }}>
                    {priceStr}
                    {qty > 1 ? <> &nbsp;·&nbsp; {qty} units</> : null}
                    {!isSorted ? (
                      <>
                        {' '}
                        &nbsp;·&nbsp; <span style={{ color: '#e8741c', fontWeight: 700 }}>tap to confirm</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div
                style={{ display: 'flex', gap: 6, paddingLeft: 26 }}
                onClick={(e) => e.stopPropagation()}
                role="presentation"
              >
                <select
                  className={styles.select}
                  style={{ flex: 2, minWidth: 0 }}
                  value={r.catalog_name || ''}
                  aria-label={`Catalog item for ${r.name}`}
                  onChange={(e) => onCatalogPick(i, e.target.value)}
                >
                  <option value="">— pick catalog item —</option>
                  <option value={NEW_ITEM}>+ New catalog item…</option>
                  {catalogNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.select}
                  style={{ flex: 1.4, minWidth: 0 }}
                  value={locationValue(r.category, r.aisle ?? null)}
                  title="Where in the store this lives — pick a section (Produce, Dairy, …) OR an aisle number"
                  aria-label={`Location for ${r.name}`}
                  onChange={(e) => void onLocationPick(i, e.target.value)}
                >
                  <option value="">— pick location —</option>
                  {locOpts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
