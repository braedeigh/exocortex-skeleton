/**
 * RecipePanel.tsx — the recipe-sourcing card shown while a recipe is being
 * traced (port of _ecoRecipePanel). Traced ingredients focus their source on
 * tap; untraced ones offer one-tap "Place" (opens the add form pre-named);
 * pantry staples are counted but never nag.
 */
import { txInfo } from './axes';
import { ecoRecipeSourcing } from './ecoMatch';
import type { EcoRecipe, EcoSource } from './types';
import styles from './RecipePanel.module.css';

export interface RecipePanelProps {
  recipe: EcoRecipe;
  sources: EcoSource[];
  canEdit: boolean;
  onFocusSource: (id: string) => void;
  onPlaceIngredient: (name: string) => void;
  onClear: () => void;
}

export function RecipePanel({
  recipe,
  sources,
  canEdit,
  onFocusSource,
  onPlaceIngredient,
  onClear,
}: RecipePanelProps) {
  const s = ecoRecipeSourcing(recipe, sources);
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.name}>{recipe.name}</div>
        <span className={styles.count}>
          traced {s.traced.length}/{s.total}
        </span>
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          Show all
        </button>
      </div>
      {s.traced.length ? (
        s.traced.map((t, i) => (
          <button
            key={`${t.source.id}-${i}`}
            type="button"
            className={styles.tracedRow}
            onClick={() => onFocusSource(t.source.id)}
          >
            <span className={styles.dot} style={{ background: txInfo(t.source).color }} />
            <span className={styles.ing}>{t.ing.item}</span>
            <span className={styles.sourceName}>{t.source.name} &rsaquo;</span>
          </button>
        ))
      ) : (
        <div className={styles.empty}>Nothing traced yet &mdash; place these foods below.</div>
      )}
      {s.place.length ? (
        <>
          <div className={styles.placeTitle}>Not yet on the map</div>
          {s.place.map((p, i) => (
            <div key={`${p.ing.item}-${i}`} className={styles.placeRow}>
              <span className={styles.placeIng}>{p.ing.item}</span>
              {canEdit ? (
                <button
                  type="button"
                  className={styles.placeBtn}
                  onClick={() => onPlaceIngredient((p.ing.item || '').trim())}
                >
                  ＋ Place
                </button>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {s.pantry.length ? (
        <div className={styles.pantry}>
          + {s.pantry.length} pantry staple{s.pantry.length === 1 ? '' : 's'} (salt, water, spices
          &mdash; not traced)
        </div>
      ) : null}
    </div>
  );
}
