/**
 * SingleFoods.tsx — the "Single foods only" switch on the food lists: the
 * nutrient rankings (./NutrientPage.tsx) and the add-a-food search in Meals
 * (./NutritionPage.tsx). A single food is one thing you could buy as itself —
 * milk, potatoes, rice, kale — and the rule deciding it is server-side,
 * nutrition.py is_single_food. The switch is remembered in localStorage, so
 * turning it on in one list turns it on in both, and it stays on next visit.
 *
 * Prompt: "filter the foods lists by like, single vegetable or single food item
 * that I commonly eat or can buy as single ingredient … Like milk, potato, rice, kale."
 */
import { useState } from 'react';
import styles from './Nutrition.module.css';

const STORAGE_KEY = 'nutrition.singleFoodsOnly';

// Remember the switch across lists and visits.
export function useSingleFoods(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => window.localStorage.getItem(STORAGE_KEY) === '1');
  const set = (next: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    setOn(next);
  };
  return [on, set];
}

export function SingleFoodsChip({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`${styles.chip} ${on ? styles.chipOn : ''}`}
      aria-pressed={on}
      title="Plain foods you could buy as themselves — no dishes, brands, canned or sauced foods"
      onClick={() => onChange(!on)}
    >
      Single foods only
    </button>
  );
}
