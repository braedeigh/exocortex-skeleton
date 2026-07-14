/**
 * Buy List — Consumables / Durables / Services / Unsorted, each its own
 * separately-collapsible <details> (open state remembered in localStorage),
 * with items grouped by front (the shared life-domain vocabulary,
 * features/fronts) inside each kind. Category is demoted to the meta line.
 * Rows get a 🔗 order-link button when the item has an order_url; unsorted
 * rows keep the one-tap C/D/S filing words; every row has "bought" and a
 * two-step-confirm ×.
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { FRONT_EMOJI, frontLabel, useFronts } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { FrontChips, toggleFront } from './FrontChips';
import {
  BUY_KINDS,
  buyItemsOfKind,
  categoryLabel,
  formatBuyDate,
  groupBuyByFront,
  isSortedKind,
  knownBuyCategories,
  priorityColor,
  unsortedBuyItems,
} from './inventoryHelpers';
import type { BuyItem } from './types';
import styles from './inventory.module.css';

export interface BuyListSectionProps {
  items: BuyItem[];
  open: boolean;
  onOpenItem: (name: string) => void;
  onSetKind: (name: string, kind: string) => void;
  onMarkBought: (item: BuyItem) => void;
  onDelete: (name: string) => void;
  onAdd: (payload: {
    name: string;
    priority: string;
    kind: string;
    where: string;
    category: string;
    notes: string;
    fronts: string[];
  }) => Promise<void>;
}

interface RowProps {
  fronts: Front[];
  onOpenItem: (name: string) => void;
  onSetKind: (name: string, kind: string) => void;
  onMarkBought: (item: BuyItem) => void;
  onDelete: (name: string) => void;
}

function BuyRow({
  item,
  fronts,
  onOpenItem,
  onSetKind,
  onMarkBought,
  onDelete,
}: RowProps & { item: BuyItem }) {
  const meta: { key: string; node: ReactNode }[] = [];
  if (item.why) meta.push({ key: 'why', node: <em>{item.why}</em> });
  if (item.by) {
    meta.push({ key: 'by', node: <span className={styles.metaBy}>by {item.by}</span> });
  }
  if (item.category) {
    meta.push({ key: 'category', node: <span>{categoryLabel(item.category)}</span> });
  }
  if (item.added) {
    meta.push({ key: 'added', node: <span title={item.added}>added {formatBuyDate(item.added)}</span> });
  }

  const tagNames = (item.fronts || []).map((f) => frontLabel(fronts, f)).join(' · ');

  return (
    <div className={styles.buyRow}>
      <span className={styles.priorityDot} style={{ background: priorityColor(item.priority) }} />
      <button type="button" className={styles.buyName} onClick={() => onOpenItem(item.name)}>
        {item.name}
      </button>
      {item.fronts?.length ? (
        <span className={styles.frontTags} title={tagNames}>
          {(item.fronts || []).map((f) => FRONT_EMOJI[f] || '🏷️').join('')}
        </span>
      ) : null}
      {item.cost ? (
        <span className={styles.costBadge}>{item.cost}</span>
      ) : (
        <span className={styles.rowSpacer} />
      )}
      {item.order_url ? (
        <a
          className={styles.linkBtn}
          href={item.order_url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open order link: ${item.order_url}`}
          aria-label={`Open order link for ${item.name}`}
        >
          🔗
        </a>
      ) : null}
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
        title="Mark as bought"
        onClick={() => onMarkBought(item)}
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

/** One kind's items grouped by front (fronts.json order, untagged last). */
function FrontGroups({ items, rowProps }: { items: BuyItem[]; rowProps: RowProps }) {
  const groups = groupBuyByFront(
    items,
    rowProps.fronts.map((f) => f.id),
  );
  return (
    <>
      {groups.map((g) => (
        <div className={styles.catGroup} key={g.front}>
          <div className={styles.frontHeader}>
            {frontLabel(rowProps.fronts, g.front) || g.front}{' '}
            <span className={styles.count}>({g.items.length})</span>
          </div>
          {g.items.map((item) => (
            <BuyRow key={`${g.front}:${item.name}`} item={item} {...rowProps} />
          ))}
        </div>
      ))}
    </>
  );
}

/** Separately-collapsible kind block — open state sticks per kind. */
function KindSection({
  storageKey,
  label,
  color,
  count,
  children,
}: {
  storageKey: string;
  label: string;
  color: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '0';
    } catch {
      return true;
    }
  });
  return (
    <details
      className={styles.kindSection}
      open={open}
      onToggle={(e) => {
        const isOpen = e.currentTarget.open;
        setOpen(isOpen);
        try {
          localStorage.setItem(storageKey, isOpen ? '1' : '0');
        } catch {
          // private mode — state just won't stick
        }
      }}
    >
      <summary className={styles.kindSummary} style={{ color }}>
        {label} <span className={styles.count}>({count})</span>
      </summary>
      <div className={styles.kindBody}>{children}</div>
    </details>
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
  const { data: frontsData } = useFronts();
  const fronts = frontsData || [];

  const [name, setName] = useState('');
  const [kind, setKind] = useState('consumable');
  const [priority, setPriority] = useState('medium');
  const [category, setCategory] = useState('');
  const [where, setWhere] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedFronts, setSelectedFronts] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const knownCats = knownBuyCategories(items);
  const unsorted = unsortedBuyItems(items);
  const rowProps: RowProps = { fronts, onOpenItem, onSetKind, onMarkBought, onDelete };

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
        fronts: selectedFronts,
      });
      // Same reset as the old form: kind/priority/front selections stick around.
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
                <KindSection
                  key={k.key}
                  storageKey={`inv-buy-open:${k.key}`}
                  label={k.label}
                  color={k.color}
                  count={kindItems.length}
                >
                  <FrontGroups items={kindItems} rowProps={rowProps} />
                </KindSection>
              );
            })}
            {unsorted.length ? (
              <KindSection
                storageKey="inv-buy-open:unsorted"
                label="Unsorted"
                color="var(--text-muted)"
                count={unsorted.length}
              >
                <div className={styles.unsortedHint}>
                  Tap C / D / S to file as Consumable, Durable or Service
                </div>
                <FrontGroups items={unsorted} rowProps={rowProps} />
              </KindSection>
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
            <FrontChips
              selected={selectedFronts}
              onToggle={(f) => setSelectedFronts((s) => toggleFront(s, f))}
            />
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
