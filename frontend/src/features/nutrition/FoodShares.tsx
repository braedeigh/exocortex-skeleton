/**
 * FoodShares.tsx — which of her foods each nutrient comes from, and what each
 * food gives her. Both are the same numbers as the day's totals, split food by
 * food (nutrition.py `totals` → `by_food`).
 *
 * Three pieces:
 * - TopSources: one line under a nutrient on the Nutrients list, e.g. "From
 *   kale 41% · ice cream 39% · broccoli 10%".
 * - NutrientSources: on a nutrient's own page, every food that gives it, with
 *   grams of her day, the amount, its share of the day, and how much of the
 *   target that food alone covers.
 * - FoodGiftsCard: on the Nutrients page, her foods one by one, each opening to
 *   the nutrients it gives, biggest part of the target first.
 *
 * Prompt that produced it: "I want to also be able to know which nutrients I
 * [get] from a food. Wanting to be able to figure out easily which ones add to
 * which nutrients."
 *
 * Touches: ./nutrientMath.ts (dayTarget, foodGifts, formatAmount, fdcFoodUrl),
 * ./types.ts, ./Nutrition.module.css; used by ./NutritionPage.tsx and
 * ./NutrientPage.tsx.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { dayTarget, fdcFoodUrl, foodGifts, formatAmount } from './nutrientMath';
import type { NutrientRow, Sex } from './types';
import styles from './Nutrition.module.css';

// Write a 0–1 share as a whole percent, with "<1%" for the crumbs.
function percent(share: number): string {
  const value = share * 100;
  return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
}

// The biggest three sources of one nutrient, as a single line.
export function TopSources({ row }: { row: NutrientRow }) {
  const shares = (row.by_food ?? []).filter((share) => share.amount > 0);
  if (!row.amount || !shares.length) return null;
  const top = shares.slice(0, 3);
  return (
    <div className={styles.note}>
      From {top.map((share) => `${share.label} ${percent(share.amount / row.amount)}`).join(' · ')}
      {shares.length > top.length ? ` · ${shares.length - top.length} more` : ''}
    </div>
  );
}

// Every food in her day that gives this nutrient, richest first.
export function NutrientSources({ row, sexes }: { row: NutrientRow; sexes: Sex[] }) {
  const shares = (row.by_food ?? []).filter((share) => share.amount > 0);
  const target = dayTarget(row, sexes);
  if (!row.unit || !shares.length) {
    return <p className={styles.muted}>None of the foods in your day have a USDA figure for this.</p>;
  }
  return (
    <ul className={styles.rows}>
      {shares.map((share) => (
        <li key={share.fdc_id} className={styles.row}>
          <div className={styles.rowTop}>
            <a href={fdcFoodUrl(share.fdc_id)} target="_blank" rel="noreferrer" className={styles.shareName}>
              {share.label}
            </a>
            <span className={styles.rowAmount}>
              {formatAmount(share.amount)} {row.unit}
            </span>
          </div>
          <div className={styles.barLine}>
            <span className={styles.barSex}>{percent(share.amount / row.amount)}</span>
            <div className={styles.bar}>
              <div className={styles.barFill} style={{ width: `${(share.amount / row.amount) * 100}%` }} />
            </div>
            <span className={styles.barPercent}>
              {target ? `${percent(share.amount / target)} of target` : 'no target'}
            </span>
          </div>
          {share.meals.length ? <div className={styles.note}>in {share.meals.join(', ')}</div> : null}
        </li>
      ))}
    </ul>
  );
}

// Her foods one by one, each opening to what it gives.
export function FoodGiftsCard({ rows, sexes }: { rows: NutrientRow[]; sexes: Sex[] }) {
  const foods = foodGifts(rows, sexes);
  if (!foods.length) return null;
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>What each food gives you</div>
      <p className={styles.muted}>
        Tap a food to see every nutrient it adds to your day, largest share of the daily target first.
      </p>
      <ul className={styles.rows}>
        {foods.map((food) => (
          <FoodGiftRow key={food.fdc_id} food={food} />
        ))}
      </ul>
    </section>
  );
}

// One food: a summary of its top three, and the whole list when opened.
function FoodGiftRow({ food }: { food: ReturnType<typeof foodGifts>[number] }) {
  const [open, setOpen] = useState(false);
  const targeted = food.gifts.filter((gift) => gift.percentOfTarget != null);
  return (
    <li className={styles.row}>
      <button type="button" className={styles.mealHead} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <span className={styles.mealName}>{food.label}</span>
      </button>
      {!open ? (
        <div className={styles.note}>
          {targeted
            .slice(0, 3)
            .map((gift) => `${gift.label} ${Math.round(gift.percentOfTarget ?? 0)}%`)
            .join(' · ')}
          {targeted.length ? ' of target' : ''}
        </div>
      ) : (
        <>
          <div className={styles.note}>
            <a href={fdcFoodUrl(food.fdc_id)} target="_blank" rel="noreferrer">
              USDA entry
            </a>
            {food.meals.length ? ` · in ${food.meals.join(', ')}` : ''}
          </div>
          <table className={styles.giftTable}>
            <thead>
              <tr>
                <th>Nutrient</th>
                <th>Amount</th>
                <th>Of target</th>
                <th>Of your day</th>
              </tr>
            </thead>
            <tbody>
              {food.gifts.map((gift) => (
                <tr key={gift.key}>
                  <td>
                    <Link to="/food/nutrients/$key" params={{ key: gift.key }}>
                      {gift.label}
                    </Link>
                  </td>
                  <td>
                    {formatAmount(gift.amount)} {gift.unit}
                  </td>
                  <td>{gift.percentOfTarget == null ? '–' : percent(gift.percentOfTarget / 100)}</td>
                  <td>{percent(gift.shareOfDay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </li>
  );
}
