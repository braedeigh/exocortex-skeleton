/**
 * Buy List — the phone-first view. Three controls up top: a store-filter chip
 * row (tap the store you're standing in to see just what's there), a quiet
 * by-priority / by-category switch, and then the items themselves as compact
 * cards inside collapsible groups (each group's open state, and the chosen
 * grouping, stick in localStorage).
 *
 * Each card is deliberately quiet: priority as a colored left edge, the name,
 * and one muted sub-line (📍 where · cost · by-date, the date in red). Tap the
 * card to open the edit sheet for everything else — why, notes, fronts, kind,
 * order link. The row itself keeps only ✓ bought and × remove.
 *
 * Grouping defaults to priority. Category is offered alongside it because a
 * list where nearly everything sits at one priority collapses into a single
 * wall of items — category is the axis that still separates things then.
 *
 * Adding happens in BuyAddBar at the top of the page, not here — this section
 * only shows and clears the list.
 *
 * Prompt: make the Buy List bearable on a phone — see items without a bunch of
 * detail like the to-do pages, tap to edit, list priority and where-to-buy;
 * one-tap filter by store for when out and about, and move the entry form to
 * the top of the page.
 *
 * Touches: inventoryHelpers (groupBuyByPriority, groupBuyByCategory,
 * buyStores, filterBuyByStore, formatByDate, priorityColor), BuyAddBar (the
 * add form that used to live here), inventory.module.css.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  buyStores,
  filterBuyByStore,
  formatByDate,
  groupBuyByCategory,
  groupBuyByPriority,
  priorityColor,
} from './inventoryHelpers';
import type { BuyItem } from './types';
import styles from './inventory.module.css';

export interface BuyListSectionProps {
  items: BuyItem[];
  open: boolean;
  onOpenItem: (name: string) => void;
  onMarkBought: (item: BuyItem) => void;
  onDelete: (name: string) => void;
}

/** Which axis the list is grouped on — the toggle above the groups. */
type Grouping = 'priority' | 'category';

const GROUPING_KEY = 'inv-buy-group';

interface BuyGroup {
  key: string;
  label: string;
  color: string;
  items: BuyItem[];
}

/** Both groupings flattened to one shape so the render below doesn't branch.
 * Priority groups carry their color; category headers stay neutral (the color
 * on a category row would collide with the priority edge on its cards). */
function buildGroups(items: BuyItem[], grouping: Grouping): BuyGroup[] {
  if (grouping === 'category') {
    return groupBuyByCategory(items).map((g) => ({
      key: g.category,
      label: g.label,
      color: 'var(--text-secondary)',
      items: g.items,
    }));
  }
  return groupBuyByPriority(items).map((g) => ({
    key: g.priority,
    label: g.label,
    color: g.color,
    items: g.items,
  }));
}

/** Compact card: colored priority edge, name, quiet where·cost·by sub-line.
 * Tap the body → edit sheet; ✓ bought and × remove stay on the row. */
function BuyRow({
  item,
  onOpenItem,
  onMarkBought,
  onDelete,
}: {
  item: BuyItem;
  onOpenItem: (name: string) => void;
  onMarkBought: (item: BuyItem) => void;
  onDelete: (name: string) => void;
}) {
  const where = (item.where || '').trim();
  const cost = (item.cost || '').trim();
  const by = formatByDate(item.by);
  return (
    <div className={styles.buyCard} style={{ borderLeftColor: priorityColor(item.priority) }}>
      <button
        type="button"
        className={styles.buyCardMain}
        onClick={() => onOpenItem(item.name)}
        aria-label={`Open ${item.name}`}
      >
        <span className={styles.buyCardName}>{item.name}</span>
        {where || cost || by ? (
          <span className={styles.buyCardSub}>
            {where ? <span className={styles.buyWhere}>📍 {where}</span> : null}
            {cost ? <span className={styles.buyCost}>{cost}</span> : null}
            {by ? <span className={styles.buyBy}>by {by}</span> : null}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={styles.boughtBtn}
        title="Mark bought"
        aria-label={`Mark ${item.name} bought`}
        onClick={() => onMarkBought(item)}
      >
        ✓
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
    </div>
  );
}

/** Separately-collapsible group block — open state sticks per group. */
function GroupSection({
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
  onMarkBought,
  onDelete,
}: BuyListSectionProps) {
  const [store, setStore] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(() => {
    try {
      return localStorage.getItem(GROUPING_KEY) === 'category' ? 'category' : 'priority';
    } catch {
      return 'priority';
    }
  });

  function chooseGrouping(next: Grouping) {
    setGrouping(next);
    try {
      localStorage.setItem(GROUPING_KEY, next);
    } catch {
      // private mode — the choice just won't stick
    }
  }

  const stores = buyStores(items);
  const groups = buildGroups(filterBuyByStore(items, store), grouping);

  return (
    <details className={styles.section} open={open}>
      <summary className={styles.summary}>Buy List{items.length ? ` (${items.length})` : ''}</summary>
      <div className={styles.sectionBody}>
        {items.length ? (
          <>
            {stores.length ? (
              <div className={styles.storeFilter} role="group" aria-label="Filter by store">
                <button
                  type="button"
                  className={`${styles.storeChip} ${store === null ? styles.storeChipActive : ''}`}
                  onClick={() => setStore(null)}
                >
                  All <span className={styles.count}>({items.length})</span>
                </button>
                {stores.map((s) => (
                  <button
                    type="button"
                    key={s.label}
                    className={`${styles.storeChip} ${store === s.label ? styles.storeChipActive : ''}`}
                    onClick={() => setStore((cur) => (cur === s.label ? null : s.label))}
                  >
                    {s.label} <span className={styles.count}>({s.count})</span>
                  </button>
                ))}
              </div>
            ) : null}

            {/* Quiet by design: the store chips are the loud control, so this
                one says which axis is active with color alone. */}
            <div className={styles.groupToggle} role="group" aria-label="Group by">
              {(['priority', 'category'] as Grouping[]).map((g) => (
                <button
                  type="button"
                  key={g}
                  className={`${styles.groupBtn} ${grouping === g ? styles.groupBtnActive : ''}`}
                  aria-pressed={grouping === g}
                  onClick={() => chooseGrouping(g)}
                >
                  by {g}
                </button>
              ))}
            </div>

            {groups.length ? (
              groups.map((g) => (
                <GroupSection
                  key={g.key}
                  storageKey={`inv-buy-open:${grouping}:${g.key}`}
                  label={g.label}
                  color={g.color}
                  count={g.items.length}
                >
                  {g.items.map((item) => (
                    <BuyRow
                      key={item.name}
                      item={item}
                      onOpenItem={onOpenItem}
                      onMarkBought={onMarkBought}
                      onDelete={onDelete}
                    />
                  ))}
                </GroupSection>
              ))
            ) : (
              <div className={styles.emptyList}>Nothing here{store ? ` at ${store}` : ''}</div>
            )}
          </>
        ) : (
          <div className={styles.emptyList}>Nothing on the list</div>
        )}
      </div>
    </details>
  );
}
