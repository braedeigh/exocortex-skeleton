/**
 * Buy List — kind (Consumables/Durables/Services/Unsorted) → category →
 * priority-sorted rows, plus the add form. Port of inventory.js
 * renderBuyList/addBuyItem. Unsorted rows get one-tap filing words; every row
 * has "bought" and a two-step-confirm ×.
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  BUY_KINDS,
  buyItemsOfKind,
  formatBuyDate,
  groupBuyByCategory,
  isSortedKind,
  knownBuyCategories,
  priorityColor,
  unsortedBuyItems,
} from './inventoryHelpers';
import type { CategoryGroup } from './inventoryHelpers';
import type { BuyItem } from './types';
import styles from './inventory.module.css';

export interface BuyListSectionProps {
  items: BuyItem[];
  open: boolean;
  onOpenItem: (name: string) => void;
  onSetKind: (name: string, kind: string) => void;
  onMarkBought: (name: string) => void;
  onDelete: (name: string) => void;
  onAdd: (payload: { name: string; priority: string; kind: string; where: string; category: string; notes: string }) => Promise<void>;
}

function BuyRow({
  item,
  onOpenItem,
  onSetKind,
  onMarkBought,
  onDelete,
}: {
  item: BuyItem;
  onOpenItem: (name: string) => void;
  onSetKind: (name: string, kind: string) => void;
  onMarkBought: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const meta: { key: string; node: ReactNode }[] = [];
  if (item.why) meta.push({ key: 'why', node: <em>{item.why}</em> });
  if (item.by) {
    meta.push({ key: 'by', node: <span className={styles.metaBy}>by {item.by}</span> });
  }
  if (item.added) {
    meta.push({ key: 'added', node: <span title={item.added}>added {formatBuyDate(item.added)}</span> });
  }

  return (
    <div className={styles.buyRow}>
      <span className={styles.priorityDot} style={{ background: priorityColor(item.priority) }} />
      <button type="button" className={styles.buyName} onClick={() => onOpenItem(item.name)}>
        {item.name}
      </button>
      {item.cost ? (
        <span className={styles.costBadge}>{item.cost}</span>
      ) : (
        <span className={styles.rowSpacer} />
      )}
      {!isSortedKind(item.kind)
        ? BUY_KINDS.map((k) => (
            <button
              type="button"
              key={k.key}
              className={styles.wordBtn}
              title={`File under ${k.label}`}
              onClick={() => onSetKind(item.name, k.key)}
            >
              {k.key}
            </button>
          ))
        : null}
      <button
        type="button"
        className={styles.wordBtn}
        title="Mark as bought — moves to Consumables"
        onClick={() => onMarkBought(item.name)}
      >
        bought
      </button>
      <button
        type="button"
        className={styles.deleteBtn}
        title="Remove"
        aria-label={`Remove ${item.name}`}
        onClick={() => onDelete(item.name)}
      >
        &times;
      </button>
      {meta.length ? (
        <div className={styles.metaLine}>
          {meta.map((m, i) => (
            <span key={m.key}>
              {i > 0 ? ' · ' : ''}
              {m.node}
            </span>
          ))}
        </div>
      ) : null}
      {item.notes ? <div className={styles.notesLine}>{item.notes}</div> : null}
    </div>
  );
}

function CategoryGroups({
  groups,
  rowProps,
}: {
  groups: CategoryGroup<BuyItem>[];
  rowProps: Omit<Parameters<typeof BuyRow>[0], 'item'>;
}) {
  return (
    <>
      {groups.map((g) => (
        <div className={styles.catGroup} key={g.category}>
          <div className={styles.catHeader}>
            {g.label} <span className={styles.count}>({g.items.length})</span>
          </div>
          {g.items.map((item) => (
            <BuyRow key={item.name} item={item} {...rowProps} />
          ))}
        </div>
      ))}
    </>
  );
}

export function BuyListSection({
  items,
  open,
  onOpenItem,
  onSetKind,
  onMarkBought,
  onDelete,
  onAdd,
}: BuyListSectionProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('consumable');
  const [priority, setPriority] = useState('medium');
  const [category, setCategory] = useState('');
  const [where, setWhere] = useState('');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);

  const knownCats = knownBuyCategories(items);
  const unsorted = unsortedBuyItems(items);
  const rowProps = { onOpenItem, onSetKind, onMarkBought, onDelete };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      await onAdd({
        name: trimmed,
        priority,
        kind,
        where: where.trim(),
        category: category.trim(),
        notes: notes.trim(),
      });
      // Same reset as the old form: kind/priority selections stick around.
      setName('');
      setWhere('');
      setCategory('');
      setNotes('');
    } catch {
      // error toast already pushed upstream; keep the inputs (old behavior)
    } finally {
      setAdding(false);
    }
  }

  const hasAny =
    unsorted.length > 0 || BUY_KINDS.some((k) => buyItemsOfKind(items, k.key).length > 0);

  return (
    <details className={styles.section} open={open}>
      <summary className={styles.summary}>Buy List{items.length ? ` (${items.length})` : ''}</summary>
      <div className={styles.sectionBody}>
        {hasAny ? (
          <>
            {BUY_KINDS.map((k) => {
              const kindItems = buyItemsOfKind(items, k.key);
              if (!kindItems.length) return null;
              return (
                <div className={styles.kindGroup} key={k.key}>
                  <div className={styles.kindHeader} style={{ color: k.color }}>
                    {k.label} <span className={styles.count}>({kindItems.length})</span>
                  </div>
                  <CategoryGroups groups={groupBuyByCategory(kindItems)} rowProps={rowProps} />
                </div>
              );
            })}
            {unsorted.length ? (
              <div className={styles.kindGroup}>
                <div className={styles.kindHeader} style={{ color: 'var(--text-muted)' }}>
                  Unsorted <span className={styles.count}>({unsorted.length})</span>
                </div>
                <div className={styles.unsortedHint}>
                  Tap C / D / S to file as Consumable, Durable or Service
                </div>
                <CategoryGroups groups={groupBuyByCategory(unsorted)} rowProps={rowProps} />
              </div>
            ) : null}
          </>
        ) : (
          <div className={styles.emptyList}>Nothing on the list</div>
        )}

        <form className={styles.addForm} onSubmit={submit}>
          <datalist id="inv-buy-categories">
            {knownCats.map((c) => (
              <option value={c} key={c} />
            ))}
          </datalist>
          <div className={styles.formRow}>
            <input
              type="text"
              className={`${styles.input} ${styles.grow2}`}
              placeholder="Item name..."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              className={styles.select}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Kind"
            >
              <option value="consumable">Consumable</option>
              <option value="durable">Durable</option>
              <option value="service">Service</option>
            </select>
            <select
              className={styles.select}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-label="Priority"
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className={styles.formRow}>
            <input
              type="text"
              className={`${styles.input} ${styles.grow}`}
              list="inv-buy-categories"
              placeholder="Category (e.g. supplements)"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <input
              type="text"
              className={`${styles.input} ${styles.grow}`}
              placeholder="Where (optional)"
              value={where}
              onChange={(e) => setWhere(e.target.value)}
            />
          </div>
          <div className={styles.formRow}>
            <input
              type="text"
              className={`${styles.input} ${styles.grow}`}
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <button type="submit" className={styles.primaryBtn} disabled={adding}>
              Add
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
