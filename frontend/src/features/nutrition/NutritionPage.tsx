/**
 * NutritionPage.tsx — /food/nutrients: what her usual day of meals adds up
 * to, nutrient by nutrient, against the daily targets (the DRIs).
 *
 * Top to bottom: who the targets are for (female / male / both, and age);
 * the nutrients, grouped over a limit → below target → met → no target, each
 * with its total, the range USDA's samples allow, a bar per sex against its
 * target, and plain notes where the number is softer than it looks (an AI
 * target, foods with no figure, foods whose figure was filled in from USDA's
 * survey data, a UL that doesn't count food); then her
 * meals, where each food's grams can be fixed, a food removed, or a USDA food
 * added by search. A weight nobody has weighed yet is marked "guess".
 *
 * Data: GET /api/nutrition/day (routes/nutrition.py → nutrition.py).
 * Touches: ./api.ts, ./types.ts, ./nutrientMath.ts, ./Nutrition.module.css,
 * ../ecosystem/FoodNav.tsx, ../research/ResearchPage.module.css (the page
 * frame the Food pages share). Design: docs/nutrition.md.
 *
 * Prompt that produced it: "make my own kind of like, Cronometer so I can
 * plug in my diet and see how to optimize it for my health overall."
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FoodNav } from '../ecosystem/FoodNav';
import { getDay, saveMeal, saveSettings, searchFoods } from './api';
import { barShare, formatAmount, GROUP_TITLES, groupRows } from './nutrientMath';
import type { FdcFood, Meal, MealItem, NutrientRow, NutritionDay, Sex, SexSetting } from './types';
import pageStyles from '../research/ResearchPage.module.css';
import styles from './Nutrition.module.css';

const DAY_KEY = ['nutrition', 'day'];
const SEX_WORDS: Record<Sex, string> = { female: 'female', male: 'male' };

export function NutritionPage() {
  const query = useQuery({ queryKey: DAY_KEY, queryFn: ({ signal }) => getDay(signal) });
  const data = query.data;
  const guessed = data
    ? Object.values(data.meals).some((meal) => (meal.items ?? []).some((item) => item.grams_guessed))
    : false;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Nutrients</h1>
        <span className={pageStyles.pageSub}>your usual day, against the daily targets</span>
      </div>
      <FoodNav current="nutrients" />
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : !data ? (
        <p className={styles.muted}>Could not load the nutrients.</p>
      ) : (
        <>
          {guessed ? (
            <p className={styles.warn}>
              Some gram weights below are guesses, marked <span className={styles.guess}>guess</span>. Weigh
              them once and fix them in Meals — until then these totals are rough.
            </p>
          ) : null}
          <SettingsRow day={data} />
          <NutrientList day={data} />
          <MealList day={data} />
          <p className={styles.sources}>
            Food composition: {data.report.sources.composition}. Targets: Food and Nutrition Board DRI summary
            tables ({data.report.sources.targets} in the commons); sodium and potassium from{' '}
            {data.report.sources.update_2019}. Added salt, cooking oil and supplements aren’t counted.
          </p>
        </>
      )}
    </div>
  );
}

// --- who the targets are for -------------------------------------------------------

function SettingsRow({ day }: { day: NutritionDay }) {
  const client = useQueryClient();
  const [age, setAge] = useState(day.settings.age ? String(day.settings.age) : '');
  const save = useMutation({
    mutationFn: saveSettings,
    onSuccess: () => client.invalidateQueries({ queryKey: DAY_KEY }),
  });
  const choices: SexSetting[] = ['female', 'male', 'both'];

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Targets for</div>
      <div className={styles.settingsRow}>
        {choices.map((sex) => (
          <button
            key={sex}
            type="button"
            className={`${styles.chip} ${day.settings.sex === sex ? styles.chipOn : ''}`}
            onClick={() => save.mutate({ sex })}
          >
            {sex === 'both' ? 'Both, side by side' : sex[0].toUpperCase() + sex.slice(1)}
          </button>
        ))}
        <label className={styles.ageLabel}>
          Age
          <input
            className={styles.ageInput}
            inputMode="numeric"
            value={age}
            onChange={(event) => setAge(event.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const value = Number(age);
              if (value >= 19 && value !== day.settings.age) save.mutate({ age: value });
            }}
          />
        </label>
      </div>
      {save.isError ? <p className={styles.error}>{(save.error as Error).message}</p> : null}
      {!day.settings.age ? <p className={styles.muted}>Give an age to see targets.</p> : null}
    </section>
  );
}

// --- the nutrients -------------------------------------------------------------------

function NutrientList({ day }: { day: NutritionDay }) {
  const groups = groupRows(day.report.nutrients);
  return (
    <>
      {groups.map(({ group, rows }) => (
        <section key={group} className={styles.card}>
          <div className={styles.cardHead}>{GROUP_TITLES[group]}</div>
          <ul className={styles.rows}>
            {rows.map((row) => (
              <NutrientLine key={row.key} row={row} sexes={day.report.sexes} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function NutrientLine({ row, sexes }: { row: NutrientRow; sexes: Sex[] }) {
  const unit = row.unit ?? '';
  const spread = row.high - row.low > Math.max(row.amount * 0.02, 0.01);
  // The ceiling is the same for both sexes in every adult row, so the first one says it.
  const limit = sexes.map((sex) => row.by_sex[sex]?.limit).find(Boolean);
  const isAi = sexes.some((sex) => row.by_sex[sex]?.target?.kind === 'ai');

  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowName}>{row.label}</span>
        <span className={styles.rowAmount}>
          {row.unit ? `${formatAmount(row.amount)} ${unit}` : 'no data'}
          {spread ? (
            <span className={styles.range}>
              {' '}
              ({formatAmount(row.low)}–{formatAmount(row.high)})
            </span>
          ) : null}
        </span>
      </div>

      {/* One bar per sex shown, against that sex's target. */}
      {sexes.map((sex) => {
        const judgement = row.by_sex[sex];
        const share = barShare(row.amount, judgement);
        if (share == null || !judgement?.target) return null;
        return (
          <div key={sex} className={styles.barLine}>
            {sexes.length > 1 ? <span className={styles.barSex}>{SEX_WORDS[sex]}</span> : null}
            <div className={styles.bar}>
              <div
                className={`${styles.barFill} ${styles[`status_${judgement.status}`] ?? ''}`}
                style={{ width: `${(share / 1.5) * 100}%` }}
              />
              <div className={styles.barTarget} style={{ left: `${100 / 1.5}%` }} />
            </div>
            <span className={styles.barPercent}>
              {judgement.percent ?? '–'}% of {formatAmount(judgement.target.value)}
              {judgement.target.kind === 'ai' ? '*' : ''}
            </span>
          </div>
        );
      })}

      {/* The notes that say how firm the number is. */}
      {row.missing.length ? (
        <div className={styles.note}>No USDA figure for: {row.missing.join(', ')} — the total is at least this.</div>
      ) : null}
      {row.filled?.length ? (
        <div className={styles.note}>
          Filled in from USDA's survey data (partly estimated) for: {row.filled.join(', ')}.
        </div>
      ) : null}
      {isAi ? <div className={styles.note}>* An Adequate Intake — a softer target than an RDA.</div> : null}
      {limit ? (
        <div className={styles.note}>
          {limit.kind === 'cdrr' ? 'Cut back above' : 'Upper limit'} {formatAmount(limit.value)} {unit}
          {limit.applies_to ? ` — counts ${limit.applies_to}` : ''}
        </div>
      ) : null}
    </li>
  );
}

// --- her meals -----------------------------------------------------------------------

function MealList({ day }: { day: NutritionDay }) {
  const servings = new Map(day.day.map((slot) => [slot.meal, slot.servings]));
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Meals in your usual day</div>
      {Object.entries(day.meals).map(([name, meal]) => (
        <MealEditor key={name} name={name} meal={meal} servings={servings.get(name) ?? 0} />
      ))}
    </section>
  );
}

function MealEditor({ name, meal, servings }: { name: string; meal: Meal; servings: number }) {
  const client = useQueryClient();
  const [items, setItems] = useState<MealItem[]>(meal.items ?? []);
  const [open, setOpen] = useState(false);
  useEffect(() => setItems(meal.items ?? []), [meal.items]);
  const dirty = JSON.stringify(items) !== JSON.stringify(meal.items ?? []);
  const save = useMutation({
    mutationFn: () => saveMeal(name, items),
    onSuccess: () => client.invalidateQueries({ queryKey: DAY_KEY }),
  });

  // Change one food's grams; a typed weight is no longer a guess.
  const setGrams = (index: number, text: string) =>
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, grams: Number(text) || 0, grams_guessed: false } : item)),
    );

  return (
    <div className={styles.meal}>
      <button type="button" className={styles.mealHead} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <span className={styles.mealName}>{name}</span>
        <span className={styles.mealServings}>× {servings} a day</span>
      </button>
      {open ? (
        <>
          {meal.note ? <p className={styles.muted}>{meal.note}</p> : null}
          <ul className={styles.items}>
            {items.map((item, index) => (
              <li key={`${item.fdc_id}-${index}`} className={styles.item}>
                <span className={styles.itemName}>
                  {item.label}
                  {item.grams_guessed ? <span className={styles.guess}>guess</span> : null}
                </span>
                <input
                  className={styles.gramsInput}
                  inputMode="decimal"
                  aria-label={`${item.label} grams`}
                  value={String(item.grams)}
                  onChange={(event) => setGrams(index, event.target.value)}
                />
                <span className={styles.gramsUnit}>g</span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  aria-label={`Remove ${item.label}`}
                  onClick={() => {
                    if (window.confirm(`Remove ${item.label} from ${name}?`))
                      setItems((current) => current.filter((_, i) => i !== index));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <FoodSearch onPick={(item) => setItems((current) => [...current, item])} />
          <div className={styles.mealActions}>
            <button type="button" className={styles.saveBtn} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {dirty ? (
              <button type="button" className={styles.chip} onClick={() => setItems(meal.items ?? [])}>
                Undo changes
              </button>
            ) : null}
          </div>
          {save.isError ? <p className={styles.error}>{(save.error as Error).message}</p> : null}
        </>
      ) : null}
    </div>
  );
}

// The short tag each USDA dataset shows in search results.
const DATASET_TAGS: Record<FdcFood['data_type'], string> = {
  foundation_food: 'Foundation',
  sr_legacy_food: 'SR',
  survey_fndds_food: 'FNDDS',
};

// Add a USDA food by name: type, pick one, it joins the meal at 100 g (a guess).
function FoodSearch({ onPick }: { onPick: (item: MealItem) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  // A debounce: search 300 ms after the typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['nutrition', 'search', debounced],
    queryFn: ({ signal }) => searchFoods(debounced, signal),
    enabled: debounced.length >= 2,
  });

  return (
    <div className={styles.search}>
      <input
        className={styles.searchInput}
        placeholder="Add a food — e.g. kale raw"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {debounced.length >= 2 && results.data ? (
        <ul className={styles.results}>
          {results.data.foods.map((food) => (
            <li key={food.fdc_id}>
              <button
                type="button"
                className={styles.result}
                onClick={() => {
                  onPick({ label: food.description, fdc_id: food.fdc_id, grams: 100, grams_guessed: true });
                  setText('');
                }}
              >
                {food.description}
                <span className={styles.resultTag}>{DATASET_TAGS[food.data_type]}</span>
              </button>
            </li>
          ))}
          {!results.data.foods.length ? <li className={styles.muted}>No USDA food by that name.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
