/**
 * FoodsPanel.tsx — every food in the catalog, and where each one comes from.
 *
 * What this file does: lists all the eaten foods (kind 'food' in the SQL
 * catalog), traced or not, so the gaps are visible. Filter chips cut the list
 * to untraced foods, foods known only by a USDA proxy, or foods with a dot
 * placed on purpose. Each row shows the sources the food is linked to (tap
 * one to open it); tapping the food shows only its sources on the map. The
 * owner can place a new source for a food (the add form opens pre-named and
 * pre-linked), or — while a source is open — link the food to it in one tap.
 *
 * Data comes from eco_foods on /api/data/ecosystem (server.py →
 * sourcestore.map_foods); the page (EcosystemPage.tsx) owns the selection.
 *
 * Prompt that produced this file: "i want to be able to link to every
 * possible food item in the map and see what happens."
 */
import { useMemo } from 'react';
import { txInfo } from './axes';
import type { EcoFood, EcoSource } from './types';
import styles from './Panels.module.css';

export type FoodFilter = 'all' | 'untraced' | 'proxy' | 'placed';

const FILTERS: { key: FoodFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'untraced', label: 'Untraced' },
  { key: 'proxy', label: 'USDA proxy only' },
  { key: 'placed', label: 'Placed' },
];

export interface FoodsPanelProps {
  foods: EcoFood[];
  sources: EcoSource[];
  filter: FoodFilter;
  onFilter: (f: FoodFilter) => void;
  search: string;
  onSearch: (q: string) => void;
  selectedFoodId: number | null;
  onSelectFood: (id: number | null) => void;
  onOpenSource: (id: string) => void;
  /** The open source, if any — enables one-tap "Link here". */
  openSource: EcoSource | null;
  canEdit: boolean;
  onLinkHere: (foodId: number) => void;
  onPlace: (food: EcoFood) => void;
}

/** Which bucket a food falls in, from the sources it's linked to. */
export function foodStatus(food: EcoFood, byId: Map<string, EcoSource>): Exclude<FoodFilter, 'all'> {
  const linked = food.source_ids.map((id) => byId.get(id)).filter((s): s is EcoSource => !!s);
  if (!linked.length) return 'untraced';
  return linked.some((s) => s.geo_source === 'placed') ? 'placed' : 'proxy';
}

export function FoodsPanel({
  foods,
  sources,
  filter,
  onFilter,
  search,
  onSearch,
  selectedFoodId,
  onSelectFood,
  onOpenSource,
  openSource,
  canEdit,
  onLinkHere,
  onPlace,
}: FoodsPanelProps) {
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const traced = foods.filter((f) => foodStatus(f, byId) !== 'untraced').length;

  const q = search.trim().toLowerCase();
  const list = foods.filter(
    (f) =>
      (filter === 'all' || foodStatus(f, byId) === filter) &&
      (!q || f.name.toLowerCase().includes(q) || f.products.some((p) => p.name.toLowerCase().includes(q))),
  );

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.kicker}>Foods</span>
        <span className={styles.count}>
          {traced} of {foods.length} traced
        </span>
      </div>
      <input
        type="text"
        className={styles.search}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search foods and products…"
      />
      <div className={styles.chips} style={{ marginBottom: 10 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`${styles.chip} ${filter === f.key ? styles.chipOn : ''}`}
            onClick={() => onFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className={styles.list}>
        {list.length ? (
          list.map((f) => {
            const linked = f.source_ids.map((id) => byId.get(id)).filter((s): s is EcoSource => !!s);
            const selected = selectedFoodId === f.id;
            const linkedHere = !!openSource && f.source_ids.includes(openSource.id);
            return (
              <div key={f.id} className={styles.row} style={selected ? { background: 'rgba(124, 92, 191, 0.08)' } : undefined}>
                <div className={styles.rowMain}>
                  <button
                    type="button"
                    className={styles.rowName}
                    style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', minHeight: 32 }}
                    onClick={() => onSelectFood(selected ? null : f.id)}
                    title={linked.length ? 'Show only its sources on the map' : undefined}
                  >
                    {f.name}
                  </button>
                  <div className={styles.rowSub}>
                    {f.products.length ? `${f.products.length} product${f.products.length === 1 ? '' : 's'}` : 'no products yet'}
                    {f.category ? ` · ${f.category}` : ''}
                  </div>
                  {linked.length ? (
                    <div className={styles.chips} style={{ marginTop: 4 }}>
                      {linked.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={styles.chip}
                          onClick={() => onOpenSource(s.id)}
                        >
                          <span className={styles.dot} style={{ background: txInfo(s).color }} />
                          {s.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {canEdit && openSource && !linkedHere ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnAccent}`}
                    onClick={() => onLinkHere(f.id)}
                    title={`Link ${f.name} to ${openSource.name}`}
                  >
                    Link here
                  </button>
                ) : null}
                {canEdit && !openSource ? (
                  <button type="button" className={styles.btn} onClick={() => onPlace(f)}>
                    ＋ Place
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className={styles.muted}>No foods match.</div>
        )}
      </div>
    </div>
  );
}
