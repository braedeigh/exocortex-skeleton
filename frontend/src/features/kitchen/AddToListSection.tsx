import { useRef, useState } from 'react';
import {
  capitalize,
  classifyAdd,
  filterCatalogItems,
  groupChips,
  householdItems,
  kitchenCats,
  readMyFoodsSort,
  writeMyFoodsSort,
  type CatalogItem,
  type MyFoodsSort,
} from './catalogHelpers';
import { Section } from './Section';
import type { KitchenData } from './types';
import styles from './kitchen.module.css';

interface AddActionsSlice {
  add: (name: string, category?: string) => Promise<unknown>;
  remove: (name: string) => void;
}

export interface AddToListSectionProps {
  data: KitchenData;
  actions: AddActionsSlice;
  /** ask the category-picker modal for a category (resolves null on cancel) */
  pickCategory: (name: string) => Promise<string | null>;
  addWithCategory: (name: string, category: string) => Promise<unknown>;
  onOpenCatalogEditor: () => void;
  onOpenItemNote: (name: string) => void;
  /** something was just added — a new trip might be starting (re-arms the receipt banner) */
  onItemAdded: () => void;
}

/** One catalog chip. Long-press (500ms touch) or right-click opens the item
 * note; the orange dot marks chips that have one. */
function CatalogChip({
  item,
  state,
  onTap,
  onNote,
  hasNote,
}: {
  item: CatalogItem;
  state: 'default' | 'active' | 'pending' | 'pendingRemove';
  onTap: () => void;
  onNote: () => void;
  hasNote: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const cls =
    state === 'active'
      ? `${styles.chip} ${styles.chipActive}`
      : state === 'pending'
        ? `${styles.chip} ${styles.chipPending}`
        : state === 'pendingRemove'
          ? `${styles.chip} ${styles.chipPendingRemove}`
          : styles.chip;

  const title =
    state === 'active'
      ? 'On list — tap to mark for removal'
      : state === 'pendingRemove'
        ? 'Tap again to undo removal'
        : item.count
          ? `${item.count} times`
          : '';

  return (
    <button
      type="button"
      className={cls}
      title={title}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onTap();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onNote();
      }}
      onTouchStart={() => {
        timer.current = setTimeout(() => {
          timer.current = null;
          longPressed.current = true;
          onNote();
        }, 500);
      }}
      onTouchEnd={() => {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }}
      onTouchMove={() => {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }}
    >
      {capitalize(item.name)}
      {hasNote ? <span className={styles.noteDot} /> : null}
    </button>
  );
}

export function AddToListSection({
  data,
  actions,
  pickCategory,
  addWithCategory,
  onOpenCatalogEditor,
  onOpenItemNote,
  onItemAdded,
}: AddToListSectionProps) {
  // Open state survives re-renders (the old _addToListOpen global).
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortMode, setSortMode] = useState<MyFoodsSort>(readMyFoodsSort);
  // Batch selection: names pending ADD (with category) and names pending REMOVE.
  const [pendingAdd, setPendingAdd] = useState<Map<string, string>>(new Map());
  const [pendingRemove, setPendingRemove] = useState<Set<string>>(new Set());

  const known = data.kitchen_known_items || {};
  const counts = data.kitchen_purchase_counts || {};
  const notes = data.kitchen_item_notes || {};
  const list = data.kitchen_list || [];
  const onList = new Set(list.map((i) => i.name.toLowerCase()));
  const { categoryOrder, categoryLabels } = kitchenCats(data.kitchen_category_order);

  const q = filter.trim();
  const chipFilter = q.toLowerCase();
  const catalogItems = filterCatalogItems(known, counts, chipFilter);
  const chips = groupChips(catalogItems, sortMode, categoryOrder, categoryLabels);
  const household = householdItems(known, counts);

  function setSort(mode: MyFoodsSort) {
    setSortMode(mode);
    writeMyFoodsSort(mode);
  }

  function chipState(item: CatalogItem): 'default' | 'active' | 'pending' | 'pendingRemove' {
    if (onList.has(item.name)) {
      return pendingRemove.has(item.name) ? 'pendingRemove' : 'active';
    }
    return pendingAdd.has(item.name) ? 'pending' : 'default';
  }

  function tapChip(item: CatalogItem) {
    if (onList.has(item.name)) {
      setPendingRemove((cur) => {
        const next = new Set(cur);
        if (next.has(item.name)) next.delete(item.name);
        else next.add(item.name);
        return next;
      });
      return;
    }
    setPendingAdd((cur) => {
      const next = new Map(cur);
      if (next.has(item.name)) next.delete(item.name);
      else next.set(item.name, item.cat);
      return next;
    });
  }

  async function commitBatch() {
    // Adds first, then removals — matching removals by original-case list name.
    for (const [name, category] of pendingAdd) {
      await actions.add(capitalize(name), category);
    }
    for (const name of pendingRemove) {
      const entry = list.find((i) => i.name.toLowerCase() === name.toLowerCase());
      actions.remove(entry ? entry.name : capitalize(name));
    }
    if (pendingAdd.size) onItemAdded();
    setPendingAdd(new Map());
    setPendingRemove(new Set());
  }

  function cancelBatch() {
    setPendingAdd(new Map());
    setPendingRemove(new Set());
  }

  async function addTyped() {
    const name = q;
    if (!name) return;
    const outcome = classifyAdd(name, data);
    if (outcome === 'already-on-list') {
      setFilter('');
      return;
    }
    if (outcome === 'known') {
      await actions.add(name);
      onItemAdded();
      setFilter('');
      return;
    }
    const category = await pickCategory(name);
    if (!category) return;
    await addWithCategory(name, category);
    onItemAdded();
    setFilter('');
  }

  const batchCount = pendingAdd.size + pendingRemove.size;
  const batchBar =
    batchCount > 0 ? (
      <div className={styles.batchBar}>
        <span>
          {pendingAdd.size && pendingRemove.size
            ? `Add ${pendingAdd.size} · Remove ${pendingRemove.size}`
            : pendingAdd.size
              ? `${pendingAdd.size} item${pendingAdd.size > 1 ? 's' : ''} selected`
              : `${pendingRemove.size} item${pendingRemove.size > 1 ? 's' : ''} to remove`}
        </span>
        <div className={styles.batchBarBtns}>
          <button type="button" className={styles.batchCommit} onClick={() => void commitBatch()}>
            {pendingAdd.size && pendingRemove.size ? 'Add and remove items' : pendingAdd.size ? 'Add items' : 'Remove items'}
          </button>
          <button type="button" className={styles.batchCancel} onClick={cancelBatch}>
            Cancel
          </button>
        </div>
      </div>
    ) : null;

  const searchBar = (suffix: string) => (
    <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
      <input
        type="text"
        className={styles.textInput}
        style={{ flex: 1 }}
        value={filter}
        placeholder="Search or add new item..."
        autoComplete="off"
        aria-label={`Search or add item (${suffix})`}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void addTyped();
          } else if (e.key === 'Escape') {
            setFilter('');
          }
        }}
      />
      {q ? (
        <>
          <button
            type="button"
            onClick={() => void addTyped()}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderRadius: 6,
              background: 'var(--text)',
              color: 'var(--bg)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              minHeight: 44,
            }}
          >
            + Add
          </button>
          <button type="button" className={styles.smallBtn} title="Clear" onClick={() => setFilter('')}>
            &times;
          </button>
        </>
      ) : null}
    </div>
  );

  const chipCloud = (items: CatalogItem[]) => (
    <div className={styles.chipWrap}>
      {items.map((item) => (
        <CatalogChip
          key={item.name}
          item={item}
          state={chipState(item)}
          hasNote={!!notes[item.name]}
          onTap={() => tapChip(item)}
          onNote={() => onOpenItemNote(item.name)}
        />
      ))}
    </div>
  );

  const sortBtn = (mode: MyFoodsSort, label: string) => (
    <button
      type="button"
      className={`${styles.sortBtn} ${sortMode === mode ? styles.sortBtnActive : ''}`}
      onClick={() => setSort(mode)}
    >
      {label}
    </button>
  );

  return (
    <Section
      title="Add to List"
      open={open}
      onToggle={setOpen}
      controls={
        <>
          {sortBtn('alpha', 'A–Z')}
          {sortBtn('frequency', 'Freq')}
          {sortBtn('both', 'Both')}
        </>
      }
    >
      {batchBar}
      {searchBar('top')}

      <div>
        {catalogItems.length ? (
          <>
            <div className={styles.rowFlex} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {chipFilter ? `Matches for "${chipFilter}"` : 'Quick add from favorites'}
              </div>
              <button type="button" className={styles.smallBtn} onClick={onOpenCatalogEditor}>
                Edit
              </button>
            </div>

            {chips.mode === 'alpha' ? chipCloud(chips.alpha!) : null}

            {chips.mode === 'both' ? (
              <>
                {chips.mostBought!.length ? (
                  <>
                    <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 6 }}>Most bought</div>
                    {chipCloud(chips.mostBought!)}
                  </>
                ) : null}
                {chips.restAlpha!.length ? (
                  <>
                    <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 6 }}>Everything else (A–Z)</div>
                    {chipCloud(chips.restAlpha!)}
                  </>
                ) : null}
              </>
            ) : null}

            {chips.mode === 'frequency' ? (
              <>
                {chips.mostBought!.length ? (
                  <>
                    <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 6 }}>Most bought</div>
                    {chipCloud(chips.mostBought!)}
                  </>
                ) : null}
                {chips.byCategory!.length ? (
                  <details open={!!chipFilter} style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted)', minHeight: 40, display: 'flex', alignItems: 'center' }}>
                      All items by category
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      {chips.byCategory!.map((g) => (
                        <div key={g.cat}>
                          <div className={styles.groupLabel} style={{ padding: 0, margin: '8px 0 4px' }}>{g.label}</div>
                          {chipCloud(g.items)}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}
          </>
        ) : chipFilter ? (
          <div className={styles.emptyState} style={{ fontStyle: 'italic' }}>
            No matches for &quot;{chipFilter}&quot;. Tap + Add to create a new item.
          </div>
        ) : null}
      </div>

      {searchBar('bottom')}

      <details style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed rgba(124,92,191,0.18)' }}>
        <summary
          style={{
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            padding: '4px 0',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-muted)',
            minHeight: 40,
          }}
        >
          Other grocery items{household.length ? <span className={styles.badge}>{household.length}</span> : null}
        </summary>
        {household.length ? (
          <div className={styles.chipWrap} style={{ margin: '8px 0' }}>
            {household.map((item) => (
              <CatalogChip
                key={item.name}
                item={item}
                state={chipState(item)}
                hasNote={!!notes[item.name]}
                onTap={() => tapChip(item)}
                onNote={() => onOpenItemNote(item.name)}
              />
            ))}
          </div>
        ) : (
          <div className={styles.muted13} style={{ padding: '8px 0' }}>
            No household items yet. Open <b>Edit</b> on My Foods and set any item&apos;s category to <b>Household</b> to
            move it here.
          </div>
        )}
      </details>

      {batchCount > 0 ? <div style={{ marginTop: 12 }}>{batchBar}</div> : null}
    </Section>
  );
}
