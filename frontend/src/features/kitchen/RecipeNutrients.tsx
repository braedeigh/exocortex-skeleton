/**
 * RecipeNutrients.tsx — "Nutrients per serving" on a recipe's page, Kitchen tab.
 *
 * What this file does: shows what one serving of the recipe gives against her
 * daily targets — her day's gaps first, the rest behind a toggle — using the
 * same bars as the Nutrients page (../nutrition/NutritionPage.tsx). Under that,
 * every line of the recipe with how it was counted: which USDA entry it was
 * weighed as, how many grams and how they were found, and what she's
 * sensitive to in it. Guesses are marked "guess" — an entry matched by name,
 * or grams worked out from USDA's household portions — and each can be fixed
 * here: "Change" picks the right USDA entry for the food (it holds for every
 * recipe with that food), and a grams box sets her own weight for the line.
 * Lines with nothing to weigh ("to taste") are listed as not counted.
 *
 * Data: GET /api/recipes/<id>/nutrition (routes/recipe_nutrition.py →
 * recipe_nutrition.py). Edits: ./recipeNutrition.ts. The USDA search is the
 * Nutrients page's (../nutrition/api.ts searchFoods).
 *
 * Prompt that produced it: "people can get recipes that meet their nutrient
 * requirements and they can filter by foods they are sensitive to."
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { searchFoods } from '../nutrition/api';
import { fdcFoodUrl, formatAmount } from '../nutrition/nutrientMath';
import { NutrientAmount, NutrientBars } from '../nutrition/NutritionPage';
import type { NutrientRow } from '../nutrition/types';
import {
  getRecipeNutrition,
  OVERVIEW_KEY,
  setFoodUsda,
  setLineGrams,
  type RecipeFlags,
  type RecipeNutritionLine,
} from './recipeNutrition';
import { Section } from './Section';
import styles from './kitchen.module.css';

const GUESS_STYLE = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--orange)',
  border: '1px solid var(--orange)',
  borderRadius: 4,
  padding: '0 5px',
  marginLeft: 6,
} as const;

export function RecipeNutrients({ recipeId }: { recipeId: string }) {
  const queryKey = [...OVERVIEW_KEY, recipeId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => getRecipeNutrition(recipeId, signal) });
  const [showAll, setShowAll] = useState(false);
  const data = query.data;

  const counted = data ? data.lines.length - data.not_counted.length : 0;
  const perWord = data?.per === 'recipe' ? 'the whole recipe' : 'serving';
  const rows = (data?.report.nutrients ?? []).filter((row) => row.unit);
  const gapRows = rows.filter((row) => data?.gaps.includes(row.key));
  const otherRows = rows.filter((row) => !data?.gaps.includes(row.key));

  return (
    <div style={{ margin: '0 0 18px' }}>
      <Section
        title={data?.per === 'recipe' ? 'Nutrients in the whole recipe' : 'Nutrients per serving'}
        badge={
          data ? (
            <span className={styles.muted12} style={{ fontWeight: 400 }}>
              {counted} of {data.lines.length} lines counted
            </span>
          ) : undefined
        }
      >
        <div style={{ padding: '0 0 12px' }}>
          {query.isLoading ? <div className={styles.muted13}>Adding it up…</div> : null}
          {query.isError ? <div className={styles.muted13}>Could not add it up: {(query.error as Error).message}</div> : null}
          {data ? (
            <>
              <p className={styles.muted13} style={{ margin: '0 0 10px' }}>
                {data.per === 'recipe'
                  ? 'This recipe has no servings set, so these are for the whole pot.'
                  : `One of ${data.servings} servings, against your daily targets.`}{' '}
                {data.guesses.usda || data.guesses.grams
                  ? 'Anything marked guess is worked out, not weighed — fix it in the lines below.'
                  : null}{' '}
                {data.not_counted.length ? `Not counted: ${data.not_counted.join(', ')}.` : null}
              </p>

              <FlagNotes flags={data.flags} histamineLoaded={data.histamine_source.loaded} />

              {gapRows.length ? (
                <>
                  <div className={styles.muted12} style={{ fontWeight: 700, margin: '10px 0 4px' }}>
                    Your day's gaps — what one {perWord} gives
                  </div>
                  <NutrientRows rows={gapRows} sexes={data.report.sexes} />
                </>
              ) : null}
              {otherRows.length ? (
                <button type="button" className={styles.smallBtn} onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Hide the other nutrients' : `Show the other ${otherRows.length} nutrients`}
                </button>
              ) : null}
              {showAll ? <NutrientRows rows={otherRows} sexes={data.report.sexes} /> : null}
              {!data.report.age ? (
                <div className={styles.muted12}>Set your age on the Nutrients page to see targets.</div>
              ) : null}

              <div className={styles.muted12} style={{ fontWeight: 700, margin: '14px 0 4px' }}>
                How each line was counted
              </div>
              {data.lines.map((line) => (
                <LineRow key={line.seq} recipeId={recipeId} line={line} />
              ))}
            </>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function NutrientRows({ rows, sexes }: { rows: NutrientRow[]; sexes: Parameters<typeof NutrientBars>[0]['sexes'] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((row) => (
        <li key={row.key} style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}>
            <span style={{ fontWeight: 600 }}>{row.label}</span>
            <NutrientAmount row={row} />
          </div>
          <NutrientBars row={row} sexes={sexes} />
        </li>
      ))}
    </ul>
  );
}

/** What in the recipe she's sensitive to, from her food guide and the SIGHI list. */
function FlagNotes({ flags, histamineLoaded }: { flags: RecipeFlags; histamineLoaded: boolean }) {
  const notes: [string, string, string][] = [];
  if (flags.hurts.length) notes.push(['var(--red)', 'Hurts you', flags.hurts.join(', ')]);
  if (flags.unsure.length) notes.push(['var(--orange)', 'Unsure about', flags.unsure.join(', ')]);
  if (flags.histamine_high.length) notes.push(['var(--orange)', 'High histamine (SIGHI)', flags.histamine_high.join(', ')]);
  if (flags.histamine_moderate.length)
    notes.push(['var(--text-muted)', 'Moderate or unclear histamine', flags.histamine_moderate.join(', ')]);
  if (!notes.length && histamineLoaded) return null;
  return (
    <div style={{ fontSize: 13, margin: '0 0 6px' }}>
      {notes.map(([color, label, text]) => (
        <div key={label}>
          <b style={{ color }}>{label}:</b> {text}
        </div>
      ))}
      {!histamineLoaded ? (
        <div className={styles.muted12}>The SIGHI histamine list isn't fetched on this install, so histamine isn't checked.</div>
      ) : null}
    </div>
  );
}

/** One recipe line: its USDA entry and grams, each fixable, and its flags. */
function LineRow({ recipeId, line }: { recipeId: string; line: RecipeNutritionLine }) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [gramsText, setGramsText] = useState(line.grams_source === 'yours' ? String(line.grams) : '');
  useEffect(() => setGramsText(line.grams_source === 'yours' ? String(line.grams) : ''), [line.grams, line.grams_source]);
  const refresh = () => client.invalidateQueries({ queryKey: OVERVIEW_KEY });
  const saveGrams = useMutation({
    mutationFn: (grams: number | null) => setLineGrams(recipeId, line.text, grams, line.amount),
    onSuccess: refresh,
  });
  const saveUsda = useMutation({
    mutationFn: (fdcId: number | null) => setFoodUsda(line.food_id as number, fdcId),
    onSuccess: () => {
      setPicking(false);
      refresh();
    },
  });

  // Save her grams when the box is left: a number sets it, empty goes back to the worked-out weight.
  const commitGrams = () => {
    const text = gramsText.trim();
    if (text === '' && line.grams_source === 'yours') saveGrams.mutate(null);
    else if (text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 && Number(text) !== line.grams)
      saveGrams.mutate(Number(text));
  };

  const verdict = line.histamine?.verdict;
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)', fontSize: 14 }}>
      <div>
        <b>{line.text}</b>
        {line.amount ? <span style={{ color: 'var(--text-muted)' }}> — {line.amount}</span> : null}
        {line.safety === 'hurts' ? <span style={{ color: 'var(--red)', marginLeft: 8, fontSize: 12 }}>hurts you</span> : null}
        {line.safety === 'unsure' ? <span style={{ color: 'var(--orange)', marginLeft: 8, fontSize: 12 }}>unsure</span> : null}
        {verdict && verdict !== 'low' ? (
          <span
            style={{ color: verdict === 'moderate' || verdict === 'unclear' ? 'var(--text-muted)' : 'var(--orange)', marginLeft: 8, fontSize: 12 }}
            title={`SIGHI: ${line.histamine?.sighi_name}`}
          >
            histamine {verdict}
          </span>
        ) : null}
      </div>

      {/* Which USDA entry it's weighed as: hers, or a guess by name until she picks one. */}
      <div className={styles.muted13} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 6px' }}>
        {line.usda ? (
          <>
            <span>
              as{' '}
              <a href={fdcFoodUrl(line.usda.fdc_id)} target="_blank" rel="noreferrer">
                {line.usda.description || `USDA ${line.usda.fdc_id}`}
              </a>
            </span>
            {!line.usda.confirmed ? <span style={GUESS_STYLE}>guess</span> : null}
          </>
        ) : (
          <span>no USDA entry</span>
        )}
        {line.food_id != null ? (
          <>
            <button type="button" className={styles.smallBtn} onClick={() => setPicking(!picking)}>
              {picking ? 'Cancel' : line.usda ? 'Change' : 'Pick'}
            </button>
            {line.usda && !line.usda.confirmed ? (
              <button
                type="button"
                className={`${styles.smallBtn} ${styles.smallBtnAccent}`}
                disabled={saveUsda.isPending}
                onClick={() => saveUsda.mutate(line.usda!.fdc_id)}
              >
                Right
              </button>
            ) : null}
          </>
        ) : (
          <span>(not in your food catalog)</span>
        )}
      </div>
      {picking ? <UsdaPicker initial={line.food_name || line.text} onPick={(fdcId) => saveUsda.mutate(fdcId)} /> : null}
      {saveUsda.isError ? <div style={{ color: 'var(--red)', fontSize: 13 }}>{(saveUsda.error as Error).message}</div> : null}

      {/* How many grams: hers, as written, or worked out from USDA's portions — and her box to set it. */}
      <div className={styles.muted13} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 6px' }}>
        <span>
          {line.grams != null ? `${formatAmount(line.grams)} g — ` : 'not counted — '}
          {line.grams_how}
        </span>
        {line.grams_source === 'usda_portion' ? <span style={GUESS_STYLE}>guess</span> : null}
        <input
          className={styles.textInput}
          style={{ width: 90, minHeight: 40, fontSize: 14 }}
          inputMode="decimal"
          placeholder="your g"
          aria-label={`Your grams for ${line.text}`}
          value={gramsText}
          onChange={(event) => setGramsText(event.target.value)}
          onBlur={commitGrams}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </div>
      {line.stale_grams ? (
        <div style={{ fontSize: 13, color: 'var(--orange)' }}>
          Your {formatAmount(line.stale_grams.grams)} g was for “{line.stale_grams.for_amount || 'no amount'}” — the line
          now reads “{line.amount || 'no amount'}”, so it isn't used. Type a new weight to replace it.
        </div>
      ) : null}
      {saveGrams.isError ? <div style={{ color: 'var(--red)', fontSize: 13 }}>{(saveGrams.error as Error).message}</div> : null}
    </div>
  );
}

/** Search USDA by name and pick the entry a food is; starts with the food's own name. */
function UsdaPicker({ initial, onPick }: { initial: string; onPick: (fdcId: number) => void }) {
  const [text, setText] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  // A debounce: search 300 ms after the typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['nutrition', 'search', debounced, false],
    queryFn: ({ signal }) => searchFoods(debounced, false, signal),
    enabled: debounced.length >= 2,
  });
  return (
    <div style={{ margin: '4px 0 6px' }}>
      <input
        className={styles.textInput}
        style={{ width: '100%' }}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search USDA — e.g. carrots raw"
      />
      {results.data ? (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginTop: 4 }}>
          {results.data.foods.map((food) => (
            <button
              key={food.fdc_id}
              type="button"
              onClick={() => onPick(food.fdc_id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                minHeight: 40,
                padding: '6px 10px',
                background: 'none',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                color: 'var(--text)',
                fontSize: 14,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {food.description}
            </button>
          ))}
          {!results.data.foods.length ? <div className={styles.muted13} style={{ padding: 8 }}>No USDA food by that name.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
