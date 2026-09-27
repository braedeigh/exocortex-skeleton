/**
 * RecipePanel.tsx — the recipe-sourcing card shown while a recipe is being
 * traced. An ingredient is traced when its catalog food (or a product of it)
 * is linked to a source; tapping a source opens it. Untraced ones offer
 * one-tap "Place" (the add form opens pre-named and pre-linked to the food)
 * and, when a source's name looks close, "Link to <source>?" — a suggestion
 * that only becomes a trace when tapped. A line whose words match no food in
 * the catalog says so. Pantry staples are counted but never nag.
 */
import { txInfo } from './axes';
import { ecoRecipeSourcing } from './ecoMatch';
import type { EcoIngredient, EcoRecipe, EcoSource } from './types';
import styles from './RecipePanel.module.css';

export interface RecipePanelProps {
  recipe: EcoRecipe;
  sources: EcoSource[];
  canEdit: boolean;
  onOpenSource: (id: string) => void;
  onPlaceIngredient: (ing: EcoIngredient) => void;
  onLinkSuggestion: (sourceId: string, foodId: number) => void;
  onClear: () => void;
}

export function RecipePanel({
  recipe,
  sources,
  canEdit,
  onOpenSource,
  onPlaceIngredient,
  onLinkSuggestion,
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
        s.traced.map((t, i) =>
          t.sources.map((src) => (
            <button
              key={`${src.id}-${i}`}
              type="button"
              className={styles.tracedRow}
              onClick={() => onOpenSource(src.id)}
            >
              <span className={styles.dot} style={{ background: txInfo(src).color }} />
              <span className={styles.ing}>{t.ing.item}</span>
              <span className={styles.sourceName}>{src.name} &rsaquo;</span>
            </button>
          )),
        )
      ) : (
        <div className={styles.empty}>Nothing traced yet &mdash; place these foods below.</div>
      )}
      {s.place.length ? (
        <>
          <div className={styles.placeTitle}>Not yet on the map</div>
          {s.place.map((p, i) => (
            <div key={`${p.ing.item}-${i}`} className={styles.placeRow}>
              <span className={styles.placeIng}>
                {p.ing.item}
                {p.ing.food_id == null ? <span className={styles.sourceName}> · not in the food catalog</span> : null}
              </span>
              {canEdit && p.suggestion && p.ing.food_id != null ? (
                <button
                  type="button"
                  className={styles.placeBtn}
                  title="The names look alike — link only if it's really where this comes from"
                  onClick={() => onLinkSuggestion(p.suggestion!.id, p.ing.food_id as number)}
                >
                  Link to {p.suggestion.name}?
                </button>
              ) : null}
              {canEdit ? (
                <button type="button" className={styles.placeBtn} onClick={() => onPlaceIngredient(p.ing)}>
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
