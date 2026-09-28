/**
 * NutritionPage.tsx — /food/nutrients: what her usual day of meals adds up
 * to, nutrient by nutrient, against the daily targets (the DRIs).
 *
 * Top to bottom: who the targets are for (female / male / both, and age);
 * the nutrients, grouped over a limit → below target → met → no target, each
 * with its total, the range USDA's samples allow, a bar per sex against its
 * target, and plain notes where the number is softer than it looks (an AI
 * target, foods with no figure, foods whose figure was filled in from USDA's
 * survey data, a UL that doesn't count food), and its top three sources among
 * her foods. Tapping a nutrient's name opens its own page (./NutrientPage.tsx);
 * then what each of her foods gives her (./FoodShares.tsx); then the foods she's starred
 * (./Highlights.tsx); then her meals, where each food's grams can be fixed, a food removed, or a USDA food
 * added by search; each meal's servings a day set (0 = saved but not counted);
 * a meal started or deleted. A weight nobody has weighed yet is marked "guess".
 * The Food search box (../ecosystem/foodSearch.ts) narrows which meals show;
 * the totals always count every meal.
 *
 * Prompt for the meal editing: "make sure there's a UI to be able to edit things".
 * Prompt for the nutrient link: "I want clicking on a nutrient to take me directly
 * into that nutrient file."
 *
 * Data: GET /api/nutrition/day (routes/nutrition.py → nutrition.py).
 * Touches: ./api.ts, ./types.ts, ./nutrientMath.ts, ./Nutrition.module.css,
 * ./NutrientPage.tsx (shares NutrientAmount / NutrientBars), ./Highlights.tsx,
 * ../ecosystem/FoodNav.tsx, ../research/ResearchPage.module.css (the page
 * frame the Food pages share). Design: docs/nutrition.md.
 *
 * Prompt that produced it: "make my own kind of like, Cronometer so I can
 * plug in my diet and see how to optimize it for my health overall."
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { FoodNav } from '../ecosystem/FoodNav';
import { normalizeQuery, textMatches, useFoodSearch } from '../ecosystem/foodSearch';
import { deleteMeal, getDay, saveMeal, saveServings, saveSettings, searchFoods } from './api';
import { FoodGiftsCard, TopSources } from './FoodShares';
import { StarredFoods } from './Highlights';
import { SingleFoodsChip, useSingleFoods } from './SingleFoods';
import { barShare, DATASET_TAGS, fdcFoodUrl, formatAmount, GROUP_TITLES, groupRows } from './nutrientMath';
import type { Meal, MealItem, NutrientRow, NutritionDay, Sex, SexSetting } from './types';
import pageStyles from '../research/ResearchPage.module.css';
import styles from './Nutrition.module.css';

export const DAY_KEY = ['nutrition', 'day'];
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
          <FoodGiftsCard rows={data.report.nutrients} sexes={data.report.sexes} />
          <StarredFoods />
          <MealList day={data} />
          <p className={styles.sources}>
            Food composition:{' '}
            <SourceLink href={data.report.sources.composition_url}>{data.report.sources.composition}</SourceLink>
            ; each food’s name links to its own page there. Targets:{' '}
            <SourceLink href={data.report.sources.targets_url}>
              Food and Nutrition Board DRI summary tables
            </SourceLink>{' '}
            ({data.report.sources.targets} in the commons); sodium and potassium from{' '}
            <SourceLink href={data.report.sources.update_2019_url}>{data.report.sources.update_2019}</SourceLink>.
            Added salt, cooking oil and supplements aren’t counted.
          </p>
        </>
      )}
    </div>
  );
}

// Link a cited source to the original; plain text when there's no address.
function SourceLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
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
  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <Link to="/food/nutrients/$key" params={{ key: row.key }} className={styles.rowNameBtn}>
          {row.label}
          <span aria-hidden="true">›</span>
        </Link>
        <NutrientAmount row={row} />
      </div>
      <NutrientBars row={row} sexes={sexes} />
      <TopSources row={row} />
    </li>
  );
}

// A nutrient's day total, with the range USDA's samples allow where it's wide enough to matter.
export function NutrientAmount({ row }: { row: NutrientRow }) {
  const spread = row.high - row.low > Math.max(row.amount * 0.02, 0.01);
  return (
    <span className={styles.rowAmount}>
      {row.unit ? `${formatAmount(row.amount)} ${row.unit}` : 'no data'}
      {spread ? (
        <span className={styles.range}>
          {' '}
          ({formatAmount(row.low)}–{formatAmount(row.high)})
        </span>
      ) : null}
    </span>
  );
}

// A nutrient's bars against its targets, and the notes that say how firm its number is.
// Shared with the nutrient's own page (./NutrientPage.tsx).
export function NutrientBars({ row, sexes }: { row: NutrientRow; sexes: Sex[] }) {
  const unit = row.unit ?? '';
  // The ceiling is the same for both sexes in every adult row, so the first one says it.
  const limit = sexes.map((sex) => row.by_sex[sex]?.limit).find(Boolean);
  const isAi = sexes.some((sex) => row.by_sex[sex]?.target?.kind === 'ai');

  return (
    <>
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
    </>
  );
}

// --- her meals -----------------------------------------------------------------------

// Her meals: the ones counted in her day first, in the day's order, then the saved-but-not-counted ones.
function MealList({ day }: { day: NutritionDay }) {
  const client = useQueryClient();
  const [newName, setNewName] = useState('');
  const servings = new Map(day.day.map((slot) => [slot.meal, slot.servings]));
  const counted = day.day.map((slot) => slot.meal).filter((name) => day.meals[name]);
  const allNames = [...counted, ...Object.keys(day.meals).filter((name) => !servings.has(name))];
  // The Food search shows only meals whose name or any food in them matches;
  // the day's totals above still count every meal.
  const [areaSearch] = useFoodSearch();
  const needle = normalizeQuery(areaSearch);
  const names = allNames.filter(
    (name) => textMatches(needle, name, ...(day.meals[name]?.items ?? []).map((item) => item.label)),
  );
  const trimmed = newName.trim();

  // Start a new meal: saved empty, then counted once a day so it shows up in the totals.
  const create = useMutation({
    mutationFn: async () => {
      await saveMeal(trimmed, []);
      await saveServings(trimmed, 1);
    },
    onSuccess: () => {
      setNewName('');
      client.invalidateQueries({ queryKey: DAY_KEY });
    },
  });

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Meals in your usual day</div>
      {needle && names.length < allNames.length ? (
        <p className={styles.muted}>
          {names.length} of {allNames.length} meals have “{areaSearch.trim()}”; totals still count them all.
        </p>
      ) : null}
      {names.map((name) => (
        <MealEditor key={name} name={name} meal={day.meals[name]} servings={servings.get(name) ?? 0} />
      ))}
      <div className={styles.newMeal}>
        <input
          className={styles.searchInput}
          placeholder="New meal — e.g. lunch"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <button
          type="button"
          className={styles.saveBtn}
          disabled={!trimmed || trimmed in day.meals || create.isPending}
          onClick={() => create.mutate()}
        >
          Add meal
        </button>
      </div>
      {create.isError ? <p className={styles.error}>{(create.error as Error).message}</p> : null}
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
  const remove = useMutation({
    mutationFn: () => deleteMeal(name),
    onSuccess: () => client.invalidateQueries({ queryKey: DAY_KEY }),
  });

  // Servings a day, saved when the box loses focus; 0 keeps the meal but stops counting it.
  const [servingsText, setServingsText] = useState(String(servings));
  useEffect(() => setServingsText(String(servings)), [servings]);
  const servingsSave = useMutation({
    mutationFn: (value: number) => saveServings(name, value),
    onSuccess: () => client.invalidateQueries({ queryKey: DAY_KEY }),
  });
  const commitServings = () => {
    const value = Number(servingsText);
    if (servingsText.trim() === '' || !Number.isFinite(value) || value < 0) setServingsText(String(servings));
    else if (value !== servings) servingsSave.mutate(value);
  };

  // Change one food's grams; a typed weight is no longer a guess.
  const setGrams = (index: number, text: string) =>
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, grams: Number(text) || 0, grams_guessed: false } : item)),
    );

  return (
    <div className={styles.meal}>
      <div className={styles.mealTop}>
        <button type="button" className={styles.mealHead} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>{open ? '▾' : '▸'}</span>
          <span className={styles.mealName}>{name}</span>
          {servings === 0 ? <span className={styles.mealServings}>not counted</span> : null}
        </button>
        <span className={styles.gramsUnit}>×</span>
        <input
          className={styles.gramsInput}
          inputMode="decimal"
          aria-label={`${name} servings a day`}
          value={servingsText}
          onChange={(event) => setServingsText(event.target.value)}
          onBlur={commitServings}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <span className={styles.gramsUnit}>a day</span>
      </div>
      {servingsSave.isError ? <p className={styles.error}>{(servingsSave.error as Error).message}</p> : null}
      {open ? (
        <>
          {meal.note ? <p className={styles.muted}>{meal.note}</p> : null}
          <ul className={styles.items}>
            {items.map((item, index) => (
              <li key={`${item.fdc_id}-${index}`} className={styles.item}>
                <span className={styles.itemName}>
                  <a href={fdcFoodUrl(item.fdc_id)} target="_blank" rel="noreferrer">
                    {item.label}
                  </a>
                  {item.fill_from ? (
                    <a className={styles.fillLink} href={fdcFoodUrl(item.fill_from)} target="_blank" rel="noreferrer">
                      gaps filled from
                    </a>
                  ) : null}
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
            <button
              type="button"
              className={styles.chip}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete the meal “${name}” and all its foods?`)) remove.mutate();
              }}
            >
              Delete meal
            </button>
          </div>
          {remove.isError ? <p className={styles.error}>{(remove.error as Error).message}</p> : null}
          {save.isError ? <p className={styles.error}>{(save.error as Error).message}</p> : null}
        </>
      ) : null}
    </div>
  );
}

// Add a USDA food by name: type, pick one, it joins the meal at 100 g (a guess).
function FoodSearch({ onPick }: { onPick: (item: MealItem) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [singleOnly, setSingleOnly] = useSingleFoods();
  // A debounce: search 300 ms after the typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['nutrition', 'search', debounced, singleOnly],
    queryFn: ({ signal }) => searchFoods(debounced, singleOnly, signal),
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
      <SingleFoodsChip on={singleOnly} onChange={setSingleOnly} />
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
