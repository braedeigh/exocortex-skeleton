/**
 * "Durables" — the things-you-own catalog (static/js/archivals.js): search /
 * filter / sort over three views (Cloud auto-laid-out category boxes, Cards
 * photo grid, Table), plus the add/edit modal. View mode persists under the
 * old localStorage key 'archViewMode'; filter/search/sort state lives here so
 * the 5s poll can't reset it (the old module-level globals).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ARCH_SECONDHAND,
  ARCH_VIEW_MODE_STORAGE_KEY,
  activeFilterCount,
  allCategories,
  allMaterials,
  archPhotoUrl,
  capitalize,
  clothingSubcategories,
  emptyFilters,
  emptyMessage,
  formatArchDate,
  getFilteredItems,
  sortArchivals,
} from './archivalHelpers';
import type { ArchFilters, ArchSort, ArchViewMode } from './archivalHelpers';
import { buildCloudLayout, ARCH_THUMB_H, ARCH_THUMB_W } from './cloudLayout';
import type { ArchivalItem } from './types';
import styles from './inventory.module.css';

function readStoredViewMode(): ArchViewMode {
  try {
    const v = localStorage.getItem(ARCH_VIEW_MODE_STORAGE_KEY);
    if (v === 'cloud' || v === 'cards' || v === 'table') return v;
  } catch {
    // localStorage unavailable
  }
  return 'cards';
}

// --- Cards view ---

function ArchCard({ item, onOpen }: { item: ArchivalItem; onOpen: (id: string) => void }) {
  const url = archPhotoUrl(item);
  return (
    <button type="button" className={styles.archCard} onClick={() => onOpen(item.id)}>
      {item.private === 'yes' ? <span className={styles.privateBadge}>🔒</span> : null}
      {url ? (
        <img className={styles.archCardImg} src={url} loading="lazy" alt="" />
      ) : (
        <div className={styles.archCardPlaceholder}>📦</div>
      )}
      <div className={styles.archCardName}>{item.name}</div>
      {item.description ? (
        <div className={styles.archCardField}>
          <div className={styles.archCardFieldLabel}>Description</div>
          <div className={styles.archCardDesc}>{item.description}</div>
        </div>
      ) : null}
      {item.category ? (
        <div className={styles.archCardField}>
          <span className={styles.archCardFieldLabel}>Category </span>
          <span className={styles.archCardFieldValue}>{item.category}</span>
        </div>
      ) : null}
      {item.origin ? (
        <div className={styles.archCardField}>
          <span className={styles.archCardFieldLabel}>Origin </span>
          <span className={styles.archCardFieldValue}>{item.origin}</span>
        </div>
      ) : null}
      {item.created_at ? (
        <div className={styles.archCardAdded} title={item.created_at}>
          Added {formatArchDate(item.created_at)}
        </div>
      ) : null}
    </button>
  );
}

// --- Table view ---

function ArchTable({ items, onOpen }: { items: ArchivalItem[]; onOpen: (id: string) => void }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Photo</th>
            <th>Name</th>
            <th>Category</th>
            <th>Origin</th>
            <th>Source</th>
            <th>Added</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const url = archPhotoUrl(item);
            return (
              <tr className={styles.archRow} key={item.id} onClick={() => onOpen(item.id)}>
                <td>
                  {url ? (
                    <img className={styles.archThumb} src={url} loading="lazy" alt="" />
                  ) : (
                    <div className={styles.archThumbPlaceholder}>📦</div>
                  )}
                </td>
                <td>
                  <b>{item.name}</b>
                  {item.private === 'yes' ? ' 🔒' : ''}
                </td>
                <td>{item.category || '—'}</td>
                <td>{item.origin || '—'}</td>
                <td>{item.secondhand ? capitalize(item.secondhand) : '—'}</td>
                <td className={`${styles.tdSmall} ${styles.tdMuted} ${styles.tdNowrap}`} title={item.created_at || ''}>
                  {formatArchDate(item.created_at) || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Cloud view ---

function ArchCloudView({ items, onOpen }: { items: ArchivalItem[]; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Re-layout when the container resizes (old code debounced window resize
  // by 150ms; ResizeObserver also catches the split-divider drag).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setWidth(el.clientWidth), 150);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  const layout = useMemo(() => buildCloudLayout(items, width || 600), [items, width]);

  return (
    <div ref={ref} className={styles.cloudContainer} style={{ height: layout.heightPx }}>
      {layout.boxes.map((box) => (
        <div
          className={styles.cloudBox}
          key={box.category}
          style={{ left: box.x, top: box.y, width: box.widthPx, height: box.heightPx }}
        >
          <div className={styles.cloudBoxLabel}>
            {box.label} <span className={styles.count}>({box.count})</span>
          </div>
          {box.thumbs.map(({ item, x, y }) => {
            const url = archPhotoUrl(item);
            return (
              <button
                type="button"
                className={styles.cloudThumb}
                key={item.id}
                title={item.name}
                style={{ left: x, top: y, width: ARCH_THUMB_W, height: ARCH_THUMB_H }}
                onClick={() => onOpen(item.id)}
              >
                {url ? (
                  <img src={url} loading="lazy" alt="" />
                ) : (
                  <div className={styles.cloudThumbPlaceholder}>📦</div>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// --- Filter panel ---

interface FilterPanelProps {
  items: ArchivalItem[];
  query: string;
  filters: ArchFilters;
  onToggle: (group: 'categories' | 'subcategories' | 'sources' | 'materials', value: string) => void;
  onSetGifted: (val: boolean | null) => void;
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.chip} ${active ? styles.chipActive : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FilterPanel({ items, query, filters, onToggle, onSetGifted }: FilterPanelProps) {
  const cats = allCategories(items);
  const materials = allMaterials(items);

  const catBase = getFilteredItems(items, query, filters, 'category');
  const sourceBase = getFilteredItems(items, query, filters, 'source');
  const giftedBase = getFilteredItems(items, query, filters, 'gifted');
  const giftedCount = giftedBase.filter((i) => i.gifted === 'yes').length;

  let subChips: { key: string; label: string; active: boolean }[] = [];
  if (filters.categories.includes('clothing')) {
    const subBase = getFilteredItems(items, query, filters, 'subcategory');
    const subs = clothingSubcategories(items);
    const uncatCount = subBase.filter(
      (i) => (i.category || '').trim() === 'clothing' && !(i.subcategory || '').trim(),
    ).length;
    if (uncatCount > 0) {
      subChips.push({
        key: 'uncategorized',
        label: `Uncategorized (${uncatCount})`,
        active: filters.subcategories.includes('uncategorized'),
      });
    }
    subChips = subChips.concat(
      subs.map((sub) => {
        const count = subBase.filter(
          (i) => (i.category || '').trim() === 'clothing' && (i.subcategory || '').trim() === sub,
        ).length;
        return { key: sub, label: `${capitalize(sub)} (${count})`, active: filters.subcategories.includes(sub) };
      }),
    );
  }

  const matBase = getFilteredItems(items, query, filters, 'materials');
  const matChips = materials
    .map((mat) => ({
      mat,
      count: matBase.filter((i) => (i.materials || []).some((m) => m.material === mat)).length,
    }))
    .filter((m) => m.count > 0);

  return (
    <div className={styles.filterPanel}>
      <div className={styles.filterGroup}>
        <div className={styles.filterGroupLabel}>Categories</div>
        <div className={styles.chipRow}>
          {cats.length ? (
            cats.map((cat) => (
              <Chip
                key={cat}
                label={`${capitalize(cat)} (${catBase.filter((i) => (i.category || '').trim() === cat).length})`}
                active={filters.categories.includes(cat)}
                onClick={() => onToggle('categories', cat)}
              />
            ))
          ) : (
            <span className={styles.noneYet}>None yet</span>
          )}
        </div>
      </div>

      {subChips.length ? (
        <div className={styles.filterGroup}>
          <div className={styles.filterGroupLabel}>Clothing type</div>
          <div className={styles.chipRow}>
            {subChips.map((c) => (
              <Chip key={c.key} label={c.label} active={c.active} onClick={() => onToggle('subcategories', c.key)} />
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.filterGroup}>
        <div className={styles.filterGroupLabel}>Source</div>
        <div className={styles.chipRow}>
          {ARCH_SECONDHAND.map((s) => (
            <Chip
              key={s}
              label={`${capitalize(s)} (${sourceBase.filter((i) => i.secondhand === s).length})`}
              active={filters.sources.includes(s)}
              onClick={() => onToggle('sources', s)}
            />
          ))}
        </div>
      </div>

      <div className={styles.filterGroup}>
        <div className={styles.filterGroupLabel}>Gifted</div>
        <div className={styles.chipRow}>
          <Chip label={`All (${giftedBase.length})`} active={filters.gifted === null} onClick={() => onSetGifted(null)} />
          <Chip label={`Gifted (${giftedCount})`} active={filters.gifted === true} onClick={() => onSetGifted(true)} />
          <Chip
            label={`Not gifted (${giftedBase.length - giftedCount})`}
            active={filters.gifted === false}
            onClick={() => onSetGifted(false)}
          />
        </div>
      </div>

      {matChips.length ? (
        <div className={styles.filterGroup}>
          <div className={styles.filterGroupLabel}>Materials</div>
          <div className={styles.chipRow}>
            {matChips.map(({ mat, count }) => (
              <Chip
                key={mat}
                label={`${mat} (${count})`}
                active={filters.materials.includes(mat)}
                onClick={() => onToggle('materials', mat)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Section ---

export interface ArchivalsSectionProps {
  items: ArchivalItem[];
  open: boolean;
  onOpenItem: (id: string) => void;
  onAdd: () => void;
}

const VIEW_MODES: { mode: ArchViewMode; label: string }[] = [
  { mode: 'cloud', label: '☁️ Cloud' },
  { mode: 'cards', label: '🖼 Cards' },
  { mode: 'table', label: '☰ Table' },
];

export function ArchivalsSection({ items, open, onOpenItem, onAdd }: ArchivalsSectionProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ArchSort>('newest');
  const [randomSeed, setRandomSeed] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState<ArchViewMode>(readStoredViewMode);
  const [filters, setFilters] = useState<ArchFilters>(emptyFilters);
  const sortRef = useRef<HTMLSelectElement>(null);

  function setAndStoreViewMode(mode: ArchViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(ARCH_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }

  function toggleFilter(group: 'categories' | 'subcategories' | 'sources' | 'materials', value: string) {
    setFilters((f) => {
      const arr = f[group];
      const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...f, [group]: next };
    });
  }

  const filtered = getFilteredItems(items, query, filters);
  const sorted = sortArchivals(filtered, sort, randomSeed);
  const filterCount = activeFilterCount(filters);
  const filtersBtnActive = showFilters || filterCount > 0;

  return (
    <details className={styles.section} open={open} style={{ marginTop: 20 }}>
      <summary className={styles.summary}>Durables{items.length ? ` (${items.length})` : ''}</summary>
      <div className={styles.sectionBody}>
        <div className={styles.archDesc}>
          Things you own — clothes, jewelry, sentimental. Where they came from and the stories
          attached.
        </div>

        <div className={styles.searchRow}>
          <input
            type="text"
            className={`${styles.input} ${styles.grow}`}
            placeholder="Search things..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className={styles.primaryBtn} onClick={onAdd}>
            + Add
          </button>
        </div>

        <div className={styles.controlsRow}>
          <div className={styles.viewToggle}>
            {VIEW_MODES.map(({ mode, label }) => (
              <button
                type="button"
                key={mode}
                className={`${styles.viewBtn} ${viewMode === mode ? styles.viewBtnActive : ''}`}
                onClick={() => setAndStoreViewMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Clearing on mousedown lets re-picking "Random" fire a change and
              reshuffle — the old select's onmousedown="this.value=''" trick. */}
          <select
            ref={sortRef}
            className={styles.select}
            defaultValue={sort}
            aria-label="Sort"
            onMouseDown={() => {
              if (sortRef.current) sortRef.current.value = '';
            }}
            onChange={(e) => {
              const val = (e.target.value || sort) as ArchSort;
              if (sortRef.current) sortRef.current.value = val;
              setSort(val);
              if (val === 'random') setRandomSeed((s) => s + 1);
            }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="az">A–Z</option>
            <option value="random">Random</option>
          </select>
          <button
            type="button"
            className={`${styles.filtersBtn} ${filtersBtnActive ? styles.filtersBtnOutlined : ''} ${
              showFilters ? styles.filtersBtnOpen : ''
            }`}
            onClick={() => setShowFilters((v) => !v)}
          >
            Filters
            {filterCount ? <span className={styles.filtersCount}>{filterCount}</span> : null}
          </button>
          {filterCount ? (
            <button type="button" className={styles.clearFiltersBtn} onClick={() => setFilters(emptyFilters())}>
              Clear filters
            </button>
          ) : null}
        </div>

        {showFilters ? (
          <FilterPanel
            items={items}
            query={query}
            filters={filters}
            onToggle={toggleFilter}
            onSetGifted={(val) => setFilters((f) => ({ ...f, gifted: val }))}
          />
        ) : null}

        {!sorted.length ? (
          <div className={styles.emptyMsg}>{emptyMessage(items.length)}</div>
        ) : viewMode === 'table' ? (
          <ArchTable items={sorted} onOpen={onOpenItem} />
        ) : viewMode === 'cloud' ? (
          <ArchCloudView items={sorted} onOpen={onOpenItem} />
        ) : (
          <div className={styles.cardsGrid}>
            {sorted.map((item) => (
              <ArchCard key={item.id} item={item} onOpen={onOpenItem} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
