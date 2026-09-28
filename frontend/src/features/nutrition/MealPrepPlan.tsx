/**
 * MealPrepPlan.tsx — "What to add": the fewest grams a day of her starred foods
 * that bring her usual day up to its targets, per day and for a week of meal prep.
 *
 * The solving is on the server (nutrition.py `plan_additions`, a linear program
 * run through scipy): what she already eats stays as it is, each starred food
 * is capped at a most-grams-a-day she sets, an optional calorie cap limits what
 * gets added, and no upper limit that counts food is passed. A gap her starred
 * foods can't close gets as close as it can and says so; a food with no USDA
 * figure for a nutrient is counted as giving none, and named.
 *
 * Prompt that produced it: "Then I'll want to be able to calculate how much to
 * add to my weekly meal prep or meals to meet my nutrient needs." Her answers:
 * add only (never take away), and only from the foods she's starred.
 *
 * Touches: ./api.ts (getPlan), ./types.ts, ./nutrientMath.ts, ./Highlights.tsx
 * (the starred list, so the plan reruns when it changes), ./Nutrition.module.css;
 * shown on ./NutritionPage.tsx. Design: docs/nutrition.md.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getPlan } from './api';
import { useHighlights } from './Highlights';
import { fdcFoodUrl, formatAmount } from './nutrientMath';
import type { NutritionDay } from './types';
import styles from './Nutrition.module.css';

export function MealPrepPlan({ day }: { day: NutritionDay }) {
  const { foods: starred } = useHighlights();
  const [capText, setCapText] = useState('100');
  const [energyText, setEnergyText] = useState('');
  // A debounce: the caps are read 500 ms after the typing stops.
  const [caps, setCaps] = useState({ cap: 100, energy: null as number | null });
  useEffect(() => {
    const timer = setTimeout(() => {
      const cap = Number(capText);
      const energy = energyText.trim() === '' ? null : Number(energyText);
      if (cap > 0 && cap <= 2000 && (energy == null || energy >= 0)) setCaps({ cap, energy });
    }, 500);
    return () => clearTimeout(timer);
  }, [capText, energyText]);

  // Rerun whenever the caps, the starred foods, or her day change.
  const labels = new Map(day.report.nutrients.map((row) => [row.key, row.label]));
  const query = useQuery({
    queryKey: ['nutrition', 'plan', caps, starred.map((food) => food.fdc_id).join(','), day],
    queryFn: ({ signal }) => getPlan(caps.cap, caps.energy, signal),
    enabled: starred.length > 0,
  });
  const plan = query.data;
  const gaps = (plan?.nutrients ?? []).filter((row) => row.target && row.now < row.target);

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>What to add</div>
      <p className={styles.muted}>
        The fewest grams a day of your starred foods that bring each nutrient up to its target without passing an
        upper limit. What you already eat stays the same.
      </p>
      {!starred.length ? (
        <p className={styles.muted}>Star some foods first (the ☆ on any nutrient’s page), and this works out how much of each to add.</p>
      ) : (
        <>
          <div className={styles.planInputs}>
            <label className={styles.ageLabel}>
              At most
              <input
                className={styles.gramsInput}
                inputMode="decimal"
                value={capText}
                onChange={(event) => setCapText(event.target.value)}
              />
              g of any one food a day
            </label>
            <label className={styles.ageLabel}>
              Add at most
              <input
                className={styles.gramsInput}
                inputMode="decimal"
                placeholder="any"
                value={energyText}
                onChange={(event) => setEnergyText(event.target.value)}
              />
              kcal a day
            </label>
          </div>
          {query.isLoading ? <p className={styles.muted}>Working it out&hellip;</p> : null}
          {query.isError ? <p className={styles.error}>{(query.error as Error).message}</p> : null}
          {plan ? (
            <>
              {/* The answer: grams a day of each food, and the same times seven for a week's prep. */}
              {plan.foods.length ? (
                <table className={styles.giftTable}>
                  <thead>
                    <tr>
                      <th>Add</th>
                      <th>A day</th>
                      <th>A week</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.foods.map((food) => (
                      <tr key={food.fdc_id}>
                        <td>
                          <a href={fdcFoodUrl(food.fdc_id)} target="_blank" rel="noreferrer">
                            {food.label}
                          </a>
                        </td>
                        <td>{formatAmount(food.grams)} g</td>
                        <td>{formatAmount(food.grams * 7)} g</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={styles.muted}>Nothing to add: none of your starred foods can close a gap.</p>
              )}
              {plan.added_energy != null && plan.foods.length ? (
                <div className={styles.note}>That adds {formatAmount(plan.added_energy)} kcal a day.</div>
              ) : null}

              {/* Each nutrient that was under its target: before, after, and whether it closes. */}
              <table className={styles.giftTable}>
                <thead>
                  <tr>
                    <th>Nutrient</th>
                    <th>Now</th>
                    <th>After</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <Link to="/food/nutrients/$key" params={{ key: row.key }}>
                          {labels.get(row.key) ?? row.key}
                        </Link>{' '}
                        {row.closed ? '✓' : ''}
                      </td>
                      <td>{formatAmount(row.now)}</td>
                      <td>{formatAmount(row.after)}</td>
                      <td>
                        {formatAmount(row.target ?? 0)} {row.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {gaps
                .filter((row) => !row.closed)
                .map((row) => (
                  <div key={row.key} className={styles.note}>
                    {labels.get(row.key) ?? row.key} stays short
                    {row.target ? ` at ${Math.round((row.after / row.target) * 100)}% of target` : ''}
                    {row.unknown_in.length
                      ? ` — USDA has no figure for it in ${row.unknown_in.length} of your starred foods, counted as none.`
                      : ' — your starred foods can’t close it within the caps.'}
                  </div>
                ))}
              {plan.already_over.length ? (
                <div className={styles.note}>
                  Already over an upper limit, which adding food can’t fix:{' '}
                  {plan.already_over.map((key) => labels.get(key) ?? key).join(', ')}.
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
