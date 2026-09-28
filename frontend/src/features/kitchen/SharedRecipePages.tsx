/**
 * SharedRecipePages.tsx — what someone sees when the owner shares a recipe
 * with them: the recipe itself and what one serving gives against *their*
 * targets (SharedRecipePage, /share/r/<token>), and every shared recipe, most
 * opened first, filtered by the foods they avoid (SharedRecipesPage,
 * /share/recipes).
 *
 * No login and no app shell. The visitor types their age and sex in "Your
 * numbers". Both ride in the URL and go to the server only to pick their
 * targets, and nothing is saved. What of a recipe is shown at all is decided
 * server-side (recipe_shares.py); these pages draw what arrives.
 *
 * Calls go through ./shareApi.ts. The nutrient rows reuse the Nutrients
 * page's NutrientAmount and NutrientBars, so a visitor reads them the same
 * way the owner does.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { NutrientAmount, NutrientBars } from '../nutrition/NutritionPage';
import type { NutrientRow } from '../nutrition/types';
import {
  avoidWords,
  avoidedIn,
  getShared,
  getSharedList,
  sortSharedBy,
  type SharedSummary,
  type Visitor,
} from './shareApi';
import styles from './share.module.css';

/** The nutrients shown first; the rest wait behind a button. */
const FIRST_KEYS = ['energy', 'protein', 'fiber', 'calcium', 'iron', 'magnesium', 'potassium',
  'vitamin_d', 'folate', 'vitamin_b12', 'vitamin_c', 'zinc'];

interface VisitorProps {
  visitor: Visitor;
  onVisitor: (visitor: Visitor) => void;
}

/** "Your numbers": the visitor's age and sex, which pick the targets. Kept in the URL only. */
function VisitorBox({ visitor, onVisitor }: VisitorProps) {
  const [ageText, setAgeText] = useState(visitor.age ? String(visitor.age) : '');
  // Send the age once it reads as a whole number of years; anything else clears it.
  const changeAge = (text: string) => {
    setAgeText(text);
    const age = /^\d{1,3}$/.test(text) && Number(text) >= 1 && Number(text) <= 120 ? Number(text) : null;
    if (age !== visitor.age) onVisitor({ ...visitor, age });
  };
  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Your numbers</div>
      <div className={styles.row}>
        <label className={styles.label}>
          Age{' '}
          <input
            className={styles.input}
            inputMode="numeric"
            value={ageText}
            onChange={(event) => changeAge(event.target.value)}
            placeholder="years"
          />
        </label>
        <label className={styles.label}>
          Targets for{' '}
          <select
            className={styles.select}
            value={visitor.sex}
            onChange={(event) => onVisitor({ ...visitor, sex: event.target.value as Visitor['sex'] })}
          >
            <option value="both">Women and men</option>
            <option value="female">Women</option>
            <option value="male">Men</option>
          </select>
        </label>
      </div>
      <p className={styles.note}>
        Used only to look up your daily targets (the US Dietary Reference Intakes). Nothing you type here is saved.
      </p>
    </div>
  );
}

function NutrientList({ rows, sexes }: { rows: NutrientRow[]; sexes: Parameters<typeof NutrientBars>[0]['sexes'] }) {
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <li key={row.key} className={styles.listItem}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{row.label}</span>
            <NutrientAmount row={row} />
          </div>
          <NutrientBars row={row} sexes={sexes} />
        </li>
      ))}
    </ul>
  );
}

// --- one shared recipe ---------------------------------------------------------------

export function SharedRecipePage({ token, visitor, onVisitor }: VisitorProps & { token: string }) {
  // The first load counts a view; changing "Your numbers" refetches without counting again.
  const [firstLoad] = useState(() => ({ ...visitor }));
  const { data, isPending, error } = useQuery({
    queryKey: ['share', token, visitor.sex, visitor.age],
    queryFn: ({ signal }) =>
      getShared(token, visitor, visitor.sex === firstLoad.sex && visitor.age === firstLoad.age, signal),
    staleTime: Infinity,
    retry: false,
  });
  const [showAll, setShowAll] = useState(false);

  if (isPending) return <Frame><p className={styles.meta}>Opening the recipe…</p></Frame>;
  if (error || !data) {
    return (
      <Frame>
        <h1 className={styles.title}>This recipe isn't shared any more</h1>
        <p className={styles.meta}>The link was closed by the person who shared it.</p>
        <Link to="/share/recipes" search={visitor} className={styles.moreBtn}>
          See the recipes that are shared
        </Link>
      </Frame>
    );
  }

  const nutrition = data.nutrition;
  const rows = (nutrition?.report.nutrients ?? []).filter((row) => row.unit);
  const first = FIRST_KEYS.map((key) => rows.find((row) => row.key === key)).filter(Boolean) as NutrientRow[];
  const rest = rows.filter((row) => !FIRST_KEYS.includes(row.key));
  const times = [data.prep_min ? `${data.prep_min} min prep` : '', data.cook_min ? `${data.cook_min} min cook` : '']
    .filter(Boolean);

  return (
    <Frame>
      <p className={styles.kicker}>A shared recipe</p>
      <h1 className={styles.title}>{data.name}</h1>
      <p className={styles.meta}>
        {[data.servings ? `${data.servings} servings` : '', ...times].filter(Boolean).join(' · ')}
        {data.source_url ? (
          <>
            {' · '}
            <a href={data.source_url} target="_blank" rel="noreferrer">
              original recipe
            </a>
          </>
        ) : null}
      </p>

      <VisitorBox visitor={visitor} onVisitor={onVisitor} />

      {nutrition ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            {nutrition.per === 'recipe' ? 'Nutrients in the whole recipe' : 'Nutrients per serving'}
          </div>
          {!nutrition.report.age ? (
            <p className={styles.note} style={{ marginTop: 0 }}>Type your age above to see how a serving meets your targets.</p>
          ) : nutrition.report.age < 19 ? (
            // Under 19 there are no targets to show: only the adult ones are loaded.
            <p className={styles.note} style={{ marginTop: 0 }}>
              Daily targets here are for adults (19 and over), so this shows amounts only.
            </p>
          ) : null}
          <NutrientList rows={first} sexes={nutrition.report.sexes} />
          {rest.length ? (
            <button type="button" className={styles.moreBtn} onClick={() => setShowAll((open) => !open)}>
              {showAll ? 'Hide the other nutrients' : `Show the other ${rest.length} nutrients`}
            </button>
          ) : null}
          {showAll ? <NutrientList rows={rest} sexes={nutrition.report.sexes} /> : null}
          {nutrition.not_counted.length ? (
            <p className={styles.note}>
              Not in these numbers (no amount to weigh, or no USDA figure): {nutrition.not_counted.join(', ')}.
            </p>
          ) : null}
          <HistamineNote flags={nutrition.flags} loaded={nutrition.histamine_source.loaded} />
          <p className={styles.note}>
            Worked out from USDA FoodData Central; some foods and weights are best guesses from the recipe's wording.
          </p>
        </div>
      ) : null}

      <div className={styles.card}>
        <div className={styles.cardTitle}>Ingredients</div>
        <ul className={styles.list}>
          {data.ingredients.map((ing, index) => (
            <li key={index} className={styles.listItem}>
              {ing.qty ? <b>{ing.qty} </b> : null}
              {ing.item}
              {ing.note ? <span className={styles.recipeLine}> — {ing.note}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      {data.instructions.length || data.sections.length ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Steps</div>
          {data.instructions.length ? (
            <ol className={styles.steps}>
              {data.instructions.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          ) : null}
          {data.sections.map((section, index) => (
            <div key={index}>
              {section.title ? <div className={styles.label} style={{ margin: '10px 0 6px' }}>{section.title}</div> : null}
              <ol className={styles.steps}>
                {section.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
              </ol>
            </div>
          ))}
        </div>
      ) : null}

      <Link to="/share/recipes" search={visitor} className={styles.moreBtn}>
        More shared recipes
      </Link>
    </Frame>
  );
}

function HistamineNote({ flags, loaded }: { flags: SharedSummary['flags']; loaded: boolean }) {
  if (!loaded) return null;
  if (!flags.histamine_high.length && !flags.histamine_moderate.length) return null;
  return (
    <p className={styles.note}>
      {flags.histamine_high.length ? (
        <>
          <span className={styles.warn}>High histamine (SIGHI list):</span> {flags.histamine_high.join(', ')}.{' '}
        </>
      ) : null}
      {flags.histamine_moderate.length ? <>Moderate or unclear: {flags.histamine_moderate.join(', ')}.</> : null}
    </p>
  );
}

// --- every shared recipe -------------------------------------------------------------

export function SharedRecipesPage({ visitor, onVisitor }: VisitorProps) {
  const { data, isPending, error } = useQuery({
    queryKey: ['share', 'list', visitor.sex, visitor.age],
    queryFn: ({ signal }) => getSharedList(visitor, signal),
    staleTime: 60_000,
  });
  const [avoidText, setAvoidText] = useState('');
  const [lowHistamine, setLowHistamine] = useState(false);
  const [goodFor, setGoodFor] = useState('');

  // Filter by what the visitor avoids and histamine, then sort by the nutrient they chose.
  const words = useMemo(() => avoidWords(avoidText), [avoidText]);
  const shown = useMemo(() => {
    const kept = (data?.recipes ?? []).filter(
      (recipe) =>
        !avoidedIn(recipe.ingredients, words).length && !(lowHistamine && recipe.flags.histamine_high.length),
    );
    return goodFor ? sortSharedBy(kept, goodFor) : kept;
  }, [data, words, lowHistamine, goodFor]);
  const hidden = (data?.recipes.length ?? 0) - shown.length;

  return (
    <Frame>
      <p className={styles.kicker}>Shared recipes</p>
      <h1 className={styles.title}>Recipes people have shared</h1>
      <p className={styles.meta}>Most opened first. Each one says what a serving gives against your own targets.</p>

      <VisitorBox visitor={visitor} onVisitor={onVisitor} />

      <div className={styles.card}>
        <div className={styles.cardTitle}>Filter</div>
        <label className={styles.label}>
          Foods you avoid
          <input
            className={`${styles.input} ${styles.wide}`}
            value={avoidText}
            onChange={(event) => setAvoidText(event.target.value)}
            placeholder="e.g. onion, garlic, dairy"
          />
        </label>
        <div className={styles.row} style={{ marginTop: 10 }}>
          <button
            type="button"
            className={`${styles.toggle} ${lowHistamine ? styles.toggleOn : ''}`}
            aria-pressed={lowHistamine}
            onClick={() => setLowHistamine((on) => !on)}
          >
            Low histamine
          </button>
          <select className={styles.select} value={goodFor} onChange={(event) => setGoodFor(event.target.value)}>
            <option value="">Good for…</option>
            {(data?.nutrients ?? []).map((nutrient) => (
              <option key={nutrient.key} value={nutrient.key}>
                {nutrient.label}
              </option>
            ))}
          </select>
        </div>
        <p className={styles.note}>
          Foods match whole words in the ingredient list ("onion" catches "yellow onions"). Low histamine hides recipes
          with an ingredient the SIGHI list rates high. Nothing here is saved.
        </p>
      </div>

      <div className={styles.card}>
        {isPending ? <p className={styles.meta}>Loading…</p> : null}
        {error ? <p className={styles.meta}>The shared recipes couldn't be loaded.</p> : null}
        {data && !data.recipes.length ? <p className={styles.meta}>Nothing is shared yet.</p> : null}
        {shown.map((recipe) => (
          <Link key={recipe.token} to="/share/r/$token" params={{ token: recipe.token }} search={visitor} className={styles.recipeLink}>
            <div className={styles.recipeName}>{recipe.name}</div>
            <div className={styles.recipeLine}>{summaryLine(recipe, goodFor, data?.nutrients ?? [])}</div>
          </Link>
        ))}
        {hidden > 0 ? (
          <p className={styles.note}>
            {hidden} {hidden === 1 ? 'recipe is' : 'recipes are'} hidden by your filters.
          </p>
        ) : null}
      </div>
    </Frame>
  );
}

/** A card's one line: energy, the chosen nutrient, and the two a serving gives most of. */
function summaryLine(recipe: SharedSummary, goodFor: string, labels: { key: string; label: string }[]): string {
  const name = new Map(labels.map((entry) => [entry.key, entry.label.toLowerCase()]));
  const bits: string[] = [];
  const energy = recipe.nutrients.energy;
  if (energy?.unit) bits.push(`${Math.round(energy.amount)} kcal ${recipe.per === 'recipe' ? 'in all' : 'a serving'}`);
  const withPercent = Object.entries(recipe.nutrients)
    .filter(([key, figure]) => key !== 'energy' && figure.percent != null && figure.percent > 0)
    .sort((a, b) => (b[1].percent ?? 0) - (a[1].percent ?? 0));
  const chosen = withPercent.find(([key]) => key === goodFor);
  const top = withPercent.filter(([key]) => key !== goodFor).slice(0, 2);
  for (const [key, figure] of chosen ? [chosen, ...top] : top) bits.push(`${name.get(key) ?? key} ${figure.percent}%`);
  if (recipe.counted < recipe.lines) bits.push(`${recipe.counted} of ${recipe.lines} ingredients counted`);
  return bits.join(' · ');
}

/** The page around everything: its own scroll, a centred column. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.column}>{children}</div>
    </div>
  );
}
