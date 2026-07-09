import { useRef, useState } from 'react';
import { groupGroceryItems, kitchenCats, nextSafetyTag } from './catalogHelpers';
import { locationOptions, locationValue } from './receiptHelpers';
import type { GroceryItem, KitchenData, ParsedReceiptMeta } from './types';
import styles from './kitchen.module.css';

interface GroceryActionsSlice {
  toggle: (name: string) => Promise<unknown>;
  remove: (name: string) => void;
  checkAll: (names: string[]) => Promise<unknown>;
  clearChecked: () => void;
  clearAll: () => void;
  safety: (name: string, tag: string) => void;
  location: (name: string, location: string) => void;
}

export interface GroceryListCardProps {
  data: KitchenData;
  actions: GroceryActionsSlice;
  receiptDismissed: boolean;
  onDismissReceipt: () => void;
  onScanReceipt: (file: File) => void;
  parsedReceipts: ParsedReceiptMeta[];
  onOpenImport: (filename: string) => void;
  onEditOrder: () => void;
  onEditNote: (name: string) => void;
  onConfirmRemove: (name: string) => void;
  onConfirmClearAll: () => void;
  /** fired after check-all / a toggle that completes the list (opens the Done modal) */
  onAllChecked: () => void;
}

/** Tap-to-edit location badge — swaps to a <select> in place, commits on
 * change, Escape/blur cancels (port of editGroceryAisle). */
function AisleBadge({
  item,
  aisle,
  currentCat,
  categoryOrder,
  onSet,
}: {
  item: GroceryItem;
  aisle: number | undefined;
  currentCat: string;
  categoryOrder: string[];
  onSet: (location: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const committed = useRef(false);

  if (!editing) {
    return (
      <button
        type="button"
        className={`${styles.aisleBadge} ${aisle == null ? styles.aisleBadgeEmpty : ''}`}
        title={aisle != null ? 'Tap to change location' : 'Tap to set location (section or aisle #)'}
        onClick={() => {
          committed.current = false;
          setEditing(true);
        }}
      >
        {aisle != null ? `A${aisle}` : '📍'}
      </button>
    );
  }

  const opts = locationOptions(categoryOrder, { includeNewOpt: false });
  const currentVal = locationValue(aisle != null ? '@aisles' : currentCat || '', aisle ?? null);
  return (
    <select
      className={styles.aisleSelect}
      autoFocus
      defaultValue={currentVal}
      aria-label={`Location for ${item.name}`}
      onChange={(e) => {
        committed.current = true;
        onSet(e.target.value);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          committed.current = true;
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (!committed.current) setEditing(false);
      }}
    >
      {!currentVal ? <option value="">— pick location —</option> : null}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SafetyIcon({ tag }: { tag: string }) {
  if (tag === 'safe') {
    return <span className={styles.safetySafe} title="Confirmed safe">&#10003;</span>;
  }
  if (tag === 'suspect') {
    return <span className={styles.safetySuspect} title="Suspect">&#9888;</span>;
  }
  if (tag === 'inflammatory') {
    return <span className={styles.safetyInflammatory} title="Inflammatory">&#128293;</span>;
  }
  return <span className={styles.safetyNone} title="Tap to tag safe/suspect">&#9675;</span>;
}

export function GroceryListCard({
  data,
  actions,
  receiptDismissed,
  onDismissReceipt,
  onScanReceipt,
  parsedReceipts,
  onOpenImport,
  onEditOrder,
  onEditNote,
  onConfirmRemove,
  onConfirmClearAll,
  onAllChecked,
}: GroceryListCardProps) {
  const items = data.kitchen_list || [];
  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => !!i.checked);
  const { categoryOrder, categoryLabels } = kitchenCats(data.kitchen_category_order);
  const aislesMap = data.kitchen_aisles || {};
  const safetyTags = data.kitchen_safety_tags || {};

  const allChecked = unchecked.length === 0 && checked.length > 0;
  const showReceiptBanner = allChecked && !receiptDismissed;
  const groups = groupGroceryItems(unchecked, categoryOrder, categoryLabels, aislesMap);

  function handleToggle(item: GroceryItem) {
    const wasLastUnchecked = !item.checked && unchecked.length === 1;
    void actions.toggle(item.name).then(() => {
      if (wasLastUnchecked && !receiptDismissed) onAllChecked();
    });
  }

  function handleCheckAll() {
    void actions.checkAll(unchecked.map((i) => i.name)).then(() => {
      if (!receiptDismissed) onAllChecked();
    });
  }

  return (
    <div style={{ marginBottom: 20 }}>
      {showReceiptBanner ? (
        <div className={styles.receiptBanner}>
          <span style={{ flex: 1 }}>Done shopping? Scan your receipt to log this trip.</span>
          <label className={styles.scanReceiptLabel}>
            📷 Scan receipt
            <input
              type="file"
              accept="image/*,.heic,.heif,.pdf"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onScanReceipt(f);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" className={styles.smallBtn} onClick={onDismissReceipt}>
            Dismiss
          </button>
        </div>
      ) : null}

      {parsedReceipts.length ? (
        <div className={styles.parsedBanner}>
          <div className={styles.parsedBannerTitle}>
            {parsedReceipts.length} parsed receipt{parsedReceipts.length === 1 ? '' : 's'} ready to import
          </div>
          <div className={styles.muted12} style={{ marginBottom: 2 }}>
            Categorize items + commit them to the trip log.
          </div>
          {parsedReceipts.map((r) => (
            <div className={styles.parsedBannerRow} key={r.filename}>
              <span style={{ flex: 1 }}>
                <b>{r.store || 'Receipt'}</b> · {r.date || ''} · {String(r.items_count ?? 0)} items ·{' '}
                {r.total ? `$${Number(r.total).toFixed(2)}` : '—'}
              </span>
              <button type="button" className={styles.greenBtn} style={{ minHeight: 40, padding: '5px 12px' }} onClick={() => onOpenImport(r.filename)}>
                Import
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.rowFlex} style={{ padding: '8px 0' }}>
        <span className={styles.pageTitle}>Grocery List</span>
        {items.length ? <span className={styles.muted13}>({unchecked.length} items)</span> : null}
        <label className={`${styles.fileLabel} ${styles.smallBtn} ${styles.smallBtnOngoing}`} style={{ marginLeft: 'auto' }}>
          📷 Scan receipt
          <input
            type="file"
            accept="image/*,.heic,.heif,.pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onScanReceipt(f);
              e.target.value = '';
            }}
          />
        </label>
        <button type="button" className={styles.smallBtn} onClick={onEditOrder}>
          Edit order
        </button>
      </div>

      <div className={styles.rowFlex} style={{ marginBottom: 8 }}>
        {unchecked.length ? (
          <button type="button" className={styles.smallBtn} onClick={handleCheckAll}>
            Mark all purchased
          </button>
        ) : null}
        {checked.length ? (
          <button type="button" className={styles.smallBtn} onClick={() => actions.clearChecked()}>
            Clear checked
          </button>
        ) : null}
        {items.length ? (
          <button
            type="button"
            className={`${styles.smallBtn} ${styles.smallBtnDanger}`}
            style={{ marginLeft: 'auto' }}
            onClick={onConfirmClearAll}
          >
            Clear all
          </button>
        ) : null}
      </div>

      {items.length ? (
        <div className={styles.card}>
          {groups.map((g, gi) => (
            <div key={g.label}>
              <div className={`${styles.groupLabel} ${gi > 0 ? styles.groupLabelDivider : ''}`}>{g.label}</div>
              {g.items.map((item) => {
                const key = item.name.toLowerCase();
                const noteText = (item.note || '').trim();
                const safety = safetyTags[key] || '';
                return (
                  <div className={styles.cardItem} key={item.name}>
                    <button
                      type="button"
                      className={styles.checkCircle}
                      aria-label={`Mark ${item.name} purchased`}
                      onClick={() => handleToggle(item)}
                    >
                      &#9675;
                    </button>
                    <span className={styles.itemText}>
                      {item.name}
                      {noteText ? (
                        <>
                          {' '}
                          <span
                            className={styles.inlineNote}
                            title="Tap to edit note"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditNote(item.name);
                            }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') onEditNote(item.name);
                            }}
                          >
                            — {noteText}
                          </span>
                        </>
                      ) : null}
                    </span>
                    {!noteText ? (
                      <button type="button" className={styles.addNoteBtn} title="Add a note" onClick={() => onEditNote(item.name)}>
                        + note
                      </button>
                    ) : null}
                    <AisleBadge
                      item={item}
                      aisle={aislesMap[key]}
                      currentCat={(data.kitchen_known_items || {})[key] || ''}
                      categoryOrder={categoryOrder}
                      onSet={(loc) => actions.location(key, loc)}
                    />
                    <button
                      type="button"
                      className={styles.safetyBtn}
                      title="Tap to cycle: untagged → safe → suspect → inflammatory"
                      onClick={() => actions.safety(item.name, nextSafetyTag(safety))}
                    >
                      <SafetyIcon tag={safety} />
                    </button>
                    <button type="button" className={styles.deleteBtn} title="Remove" onClick={() => onConfirmRemove(item.name)}>
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          ))}

          {checked.length ? (
            <>
              <div className={`${styles.groupLabel} ${groups.length ? styles.groupLabelDivider : ''}`}>Got it</div>
              {checked.map((item) => {
                const noteText = (item.note || '').trim();
                return (
                  <div className={`${styles.cardItem} ${styles.cardItemChecked}`} key={item.name}>
                    <button
                      type="button"
                      className={`${styles.checkCircle} ${styles.checkCircleDone}`}
                      aria-label={`Uncheck ${item.name}`}
                      onClick={() => handleToggle(item)}
                    >
                      &#9679;
                    </button>
                    <span className={`${styles.itemText} ${styles.strike}`}>
                      {item.name}
                      {noteText ? <span className={`${styles.inlineNote} ${styles.strike}`}> — {noteText}</span> : null}
                    </span>
                    <button type="button" className={styles.deleteBtn} title="Remove" onClick={() => onConfirmRemove(item.name)}>
                      &times;
                    </button>
                  </div>
                );
              })}
            </>
          ) : null}
        </div>
      ) : (
        <div className={styles.emptyState}>Nothing on the list — add an item below</div>
      )}
    </div>
  );
}
