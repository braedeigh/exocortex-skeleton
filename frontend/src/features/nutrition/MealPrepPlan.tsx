/**
 * MealPrepPlan.tsx — "What to add": the fewest grams of her starred foods that
 * bring her usual day up to its targets, split into what to eat every day and
 * what can come in a few sittings a week.
 *
 * Nutrients the body keeps a store of (calcium, iron, vitamins A and D,
 * folate, B12 — per the NIH sheets, ./StorageNote.tsx) are judged on the
 * week's average, so what only they need can be eaten a few times a week;
 * every other nutrient must be met every day. Upper limits are checked on the
 * heaviest day, the one with a weekly sitting in it.
 *
 * The solving is on the server (nutrition.py `plan_additions`, a linear program
 * run through scipy): what she already eats stays as it is, each starred food
 * is capped at a most-grams-a-day she sets, an optional calorie cap limits what
 * gets added, and no upper limit that counts food is passed. A gap her starred
 * foods can't close gets as close as it can and says so; a food with no USDA
 * figure for a nutrient is counted as giving none, and named.
 *
 * Beside each amount sits its kitchen measure ("≈ ¾ cup", ./measureMath.ts),
 * from USDA's portion weight for that food (measures.py) and linked to it; a
 * food USDA gives no cup, spoon or count for shows grams only.
 *
 * Prompt that produced it: "Then I'll want to be able to calculate how much to
 * add to my weekly meal prep or meals to meet my nutrient needs." Her answers:
 * add only (never take away), only from the foods she's starred, and stored
 * nutrients judged on a weekly average.
 *
 * Touches: ./api.ts (getPlan), ./AmountInput.tsx (useMeasures), ./types.ts, ./nutrientMath.ts, ./Highlights.tsx
 * (the starred list, so the plan reruns when it changes), ./Nutrition.module.css;
 * shown on ./NutritionPage.tsx. Design: docs/nutrition.md.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useMeasures } from './AmountInput';
import { getPlan } from './api';
import { toHousehold } from './measureMath';
import { useHighlights } from './Highlights';
import { fdcFoodUrl, formatAmount } from './nutrientMath';
import type { Measure, NutritionDay } from './types';
import { FoldCard } from './FoldCard';
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
  // Each added food's cups and spoons (measures.py), for the "≈ ¾ cup" beside its grams.
  const measures = useMeasures((plan?.foods ?? []).map((food) => food.fdc_id));
  const gaps = (plan?.nutrients ?? []).filter((row) => row.target && row.now < row.target);

  return (
    <FoldCard cardKey="plan" title="What to add" note={starred.length ? null : 'star a food first'}>
      <p className={styles.muted}>
        The fewest grams of your starred foods that bring each nutrient up to its target without passing an upper
        limit. What you already eat stays the same. Nutrients your body stores are judged on the week’s average, so
        some of this can be a few times a week instead of every day.
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
              g of any one food in a day
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
              {/* The answer: what to eat every day, what a few times a week, and the week's total to prep. */}
              {plan.foods.length ? (
                <table className={styles.giftTable}>
                  <thead>
                    <tr>
                      <th>Add</th>
                      <th>Every day</th>
                      <th>Some days</th>
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
                        <td>
                          {food.daily_grams ? `${formatAmount(food.daily_grams)} g` : '—'}
                          <Household grams={food.daily_grams} measures={measures?.[String(food.fdc_id)]} />
                        </td>
                        <td>
                          {food.times_a_week ? (
                            <>
                              {formatAmount(food.portion_grams)} g
                              <Household grams={food.portion_grams} measures={measures?.[String(food.fdc_id)]} />
                              {` × ${food.times_a_week} a week`}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{formatAmount(food.daily_grams * 7 + food.weekly_grams)} g</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={styles.muted}>Nothing to add: none of your starred foods can close a gap.</p>
              )}
              {plan.added_energy != null && plan.foods.length ? (
                <div className={styles.note}>That adds {formatAmount(plan.added_energy)} kcal a day, on average.</div>
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
                        {row.judged === 'week' ? <span className={styles.muted}> · weekly avg</span> : null}
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
    </FoldCard>
  );
}

/** "≈ ¾ cup" for some grams of a food, linked to where the cup's weight comes from; nothing when USDA gives no measure. */
function Household({ grams, measures }: { grams: number; measures: Measure[] | undefined }) {
  const household = toHousehold(grams, measures);
  if (!household) return null;
  const { measure } = household;
  return (
    <a
      className={styles.household}
      href={measure.url}
      target="_blank"
      rel="noreferrer"
      title={`${measure.label} = ${formatAmount(measure.grams)} g — ${measure.source}`}
    >
      ≈ {household.text}
    </a>
  );
}
