/**
 * Highlights.tsx — the foods she's starred as ones she's interested in eating.
 *
 * Three pieces: `useHighlights` (the starred list, and a toggle that stars or
 * unstars a food), `StarButton` (the ☆ / ★ on each food in a nutrient's
 * ranking, ./NutrientPage.tsx), and `StarredFoods` (the card on the Nutrients
 * page listing everything starred, each with its star to take it off). A star
 * is only a mark: it doesn't add the food to a meal or count it in the day.
 *
 * Data: GET / POST /api/nutrition/highlights (routes/nutrition.py), saved in
 * the data dir's `nutrition_highlights`.
 *
 * Prompt that produced it: "I want a highlight feature so I can pick foods I'm
 * interested in consuming/adding to my diet."
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getHighlights, setHighlight } from './api';
import { FoldCard } from './FoldCard';
import { fdcFoodUrl } from './nutrientMath';
import type { HighlightedFood } from './types';
import styles from './Nutrition.module.css';

const HIGHLIGHTS_KEY = ['nutrition', 'highlights'];

// The starred foods, and a toggle that writes the new list straight into the cache.
export function useHighlights() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: HIGHLIGHTS_KEY, queryFn: ({ signal }) => getHighlights(signal) });
  const foods = query.data?.foods ?? [];
  const starred = new Set(foods.map((food) => food.fdc_id));
  const toggle = useMutation({
    mutationFn: (food: { fdc_id: number; description: string }) => setHighlight(food, !starred.has(food.fdc_id)),
    onSuccess: (result) => client.setQueryData(HIGHLIGHTS_KEY, { foods: result.foods }),
  });
  return { foods, starred, toggle };
}

export function StarButton({
  food,
  on,
  onToggle,
}: {
  food: { fdc_id: number; description: string };
  on: boolean;
  onToggle: (food: { fdc_id: number; description: string }) => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.starBtn} ${on ? styles.starOn : ''}`}
      aria-pressed={on}
      aria-label={on ? `Unstar ${food.description}` : `Star ${food.description} as a food you're interested in`}
      onClick={() => onToggle(food)}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

export function StarredFoods() {
  const { foods, toggle } = useHighlights();
  return (
    <FoldCard cardKey="starred" title="Foods you’ve starred" note={foods.length ? `${foods.length} starred` : 'none yet'}>
      {foods.length ? (
        <ul className={styles.results}>
          {foods.map((food: HighlightedFood) => (
            <li key={food.fdc_id} className={styles.rankRow}>
              <span className={styles.rankName}>
                <a href={fdcFoodUrl(food.fdc_id)} target="_blank" rel="noreferrer">
                  {food.description}
                </a>
              </span>
              <StarButton food={food} on onToggle={(picked) => toggle.mutate(picked)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>
          None yet. Open a nutrient and tap ☆ beside a food you’re interested in eating — it’ll be kept here.
        </p>
      )}
      {toggle.isError ? <p className={styles.error}>{(toggle.error as Error).message}</p> : null}
    </FoldCard>
  );
}
