/**
 * EcoControls.tsx — toolbar above the map: Add-food button, recipe-trace
 * picker, and the region/world view toggle (port of _ecoControls).
 */
import type { EcoRecipe } from './types';
import styles from './EcoControls.module.css';

export type EcoView = 'region' | 'world';

export interface EcoControlsProps {
  view: EcoView;
  onSetView: (v: EcoView) => void;
  recipes: EcoRecipe[];
  recipeId: string;
  onSetRecipe: (id: string) => void;
  /** A draft is in progress — the Add button hides (old behavior). */
  adding: boolean;
  canEdit: boolean;
  onAddNew: () => void;
}

export function EcoControls({
  view,
  onSetView,
  recipes,
  recipeId,
  onSetRecipe,
  adding,
  canEdit,
  onAddNew,
}: EcoControlsProps) {
  return (
    <div className={styles.bar}>
      {adding || !canEdit ? null : (
        <button type="button" className={styles.addBtn} onClick={onAddNew}>
          ＋ Add food
        </button>
      )}
      {recipes.length ? (
        <select
          className={`${styles.recipePicker} ${recipeId ? styles.recipePickerActive : ''}`}
          title="Trace where a recipe's ingredients come from"
          value={recipeId}
          onChange={(e) => onSetRecipe(e.target.value)}
        >
          <option value="">🍲 Trace a recipe…</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      ) : null}
      <div className={styles.viewSeg}>
        <button
          type="button"
          className={`${styles.segBtn} ${view === 'region' ? styles.segBtnOn : ''}`}
          onClick={() => onSetView('region')}
        >
          My region
        </button>
        <button
          type="button"
          className={`${styles.segBtn} ${view === 'world' ? styles.segBtnOn : ''}`}
          onClick={() => onSetView('world')}
        >
          Whole world
        </button>
      </div>
    </div>
  );
}
