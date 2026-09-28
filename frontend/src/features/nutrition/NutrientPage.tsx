/**
 * NutrientPage.tsx — /food/nutrients/<key>: one nutrient's own page.
 *
 * Top to bottom: her usual day's total for it against its targets (the same
 * bars and notes as the Nutrients list); which of her foods it comes from
 * (./FoodShares.tsx); whether the body keeps a store of it or needs it
 * steadily, from its NIH fact sheet (./StorageNote.tsx); what it does and what happens if
 * you don't get enough, in the NIH Office of Dietary Supplements' own words
 * (their Health Professional Fact Sheet — Introduction, "<nutrient>
 * Deficiency", and, folded, "Groups at Risk"), with a link to the sheet; then
 * every USDA food ranked by it. Nutrients ODS has no sheet for (energy, the
 * macronutrients, fiber, sodium) say so instead of showing anything unsourced.
 *
 * Only "Your usual day" is always open; every section after it folds shut
 * behind its title (./FoldCard.tsx) and remembers open or shut on this
 * device — one choice for every nutrient's page, so opening "If you don't
 * get enough" once keeps it open on the next nutrient too.
 *
 * The ranking is per 100 kcal (density) or per 100 g, can be narrowed by
 * name, and marks each food three ways: "in your day" if her meals use it, a
 * ☆ / ★ to star it as a food she's interested in (./Highlights.tsx), and what
 * the SIGHI low-histamine list rates it. "Low histamine only" keeps just the
 * foods SIGHI rates 0 — matched by name, so the matched SIGHI entry is shown
 * on every row.
 *
 * Prompt that produced it: "I want clicking on a nutrient to take me directly
 * into that nutrient file. I want information about what happens if you don't
 * get enough of that nutrient. I want a highlight feature so I can pick foods
 * I'm interested in consuming/adding to my diet. I'm also wanting to add a
 * low histamine list in here somewhere so I can filter by low histamine if I
 * want."
 *
 * Data: GET /api/nutrition/nutrient/<key> and /api/nutrition/rank/<key>
 * (routes/nutrition.py → nutrient_facts.py, nutrition.py, histamine.py).
 * Touches: ./api.ts, ./types.ts, ./NutritionPage.tsx (NutrientAmount,
 * NutrientBars, DAY_KEY), ./Highlights.tsx, ./StorageNote.tsx, ./nutrientMath.ts,
 * ./Nutrition.module.css, ../ecosystem/FoodNav.tsx. Design: docs/nutrition.md.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useEffect, useState } from 'react';
import { FoodNav } from '../ecosystem/FoodNav';
import { getDay, getNutrient, rankFoods } from './api';
import { FoldCard } from './FoldCard';
import { NutrientSources } from './FoodShares';
import { StarButton, useHighlights } from './Highlights';
import { SingleFoodsChip, useSingleFoods } from './SingleFoods';
import { StorageCard } from './StorageNote';
import { DATASET_TAGS, fdcFoodUrl, formatAmount } from './nutrientMath';
import { DAY_KEY, NutrientAmount, NutrientBars } from './NutritionPage';
import type { FactBlock, HistamineRating, HistamineSource, NutrientFacts, RankPer } from './types';
import pageStyles from '../research/ResearchPage.module.css';
import styles from './Nutrition.module.css';

export function NutrientPage({ nutrientKey }: { nutrientKey: string }) {
  const query = useQuery({
    queryKey: ['nutrition', 'nutrient', nutrientKey],
    queryFn: ({ signal }) => getNutrient(nutrientKey, signal),
  });
  // The foods her day counts, so the ranking can mark the ones she already eats.
  const day = useQuery({ queryKey: DAY_KEY, queryFn: ({ signal }) => getDay(signal) });
  const mine = new Set(
    (day.data?.day ?? []).flatMap((slot) =>
      (day.data?.meals[slot.meal]?.items ?? []).flatMap((item) => [item.fdc_id, item.fill_from ?? 0]),
    ),
  );
  const detail = query.data;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>{detail?.row.label ?? 'Nutrient'}</h1>
        <span className={pageStyles.pageSub}>
          <Link to="/food/nutrients" className={styles.backLink}>
            ‹ All nutrients
          </Link>
        </span>
      </div>
      <FoodNav current="nutrients" />
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : !detail ? (
        <p className={styles.error}>{query.error ? (query.error as Error).message : 'Could not load this nutrient.'}</p>
      ) : (
        <>
          <section className={styles.card}>
            <div className={styles.rowTop}>
              <div className={styles.cardHead}>Your usual day</div>
              <NutrientAmount row={detail.row} />
            </div>
            <NutrientBars row={detail.row} sexes={detail.sexes} />
          </section>
          <FoldCard cardKey="page.sources" title="Where yours comes from">
            <NutrientSources row={detail.row} sexes={detail.sexes} />
          </FoldCard>
          <StorageCard storage={detail.storage} label={detail.row.label} />
          <Facts facts={detail.facts} label={detail.row.label} />
          <FoldCard cardKey="page.ranking" title="Foods richest in it" note="every USDA food">
            <FoodRanking nutrientKey={detail.row.key} label={detail.row.label} mine={mine} />
          </FoldCard>
        </>
      )}
    </div>
  );
}

// --- what ODS says -------------------------------------------------------------------

function Facts({ facts, label }: { facts: NutrientFacts; label: string }) {
  const [riskOpen, setRiskOpen] = useState(false);
  if (!facts.sheet) {
    return (
      <FoldCard cardKey="page.deficiency" title="If you don’t get enough" note="no fact sheet">
        <p className={styles.muted}>
          The NIH Office of Dietary Supplements has no fact sheet for {label.toLowerCase()}, so there’s no sourced
          text to show here yet.
        </p>
      </FoldCard>
    );
  }
  const source = (
    <p className={styles.sources}>
      Word for word from the {facts.sheet.publisher},{' '}
      <a href={facts.sheet.url} target="_blank" rel="noreferrer">
        {facts.sheet.name}
      </a>
      , with its citation numbers left out — the sheet has the references.
    </p>
  );
  if (facts.sheet.missing) {
    return (
      <FoldCard cardKey="page.deficiency" title="If you don’t get enough" note="sheet not saved">
        <p className={styles.muted}>
          The fact sheet hasn’t been saved on this install yet ({facts.sheet.file} in the commons). Read it at{' '}
          <a href={facts.sheet.url} target="_blank" rel="noreferrer">
            ODS
          </a>
          .
        </p>
      </FoldCard>
    );
  }

  return (
    <>
      <FoldCard cardKey="page.intro" title="What it does">
        <Blocks blocks={facts.intro} />
      </FoldCard>
      <FoldCard cardKey="page.deficiency" title="If you don’t get enough">
        <Blocks blocks={facts.deficiency} />
        {facts.at_risk.length ? (
          <>
            <button
              type="button"
              className={styles.rowNameBtn}
              onClick={() => setRiskOpen(!riskOpen)}
              aria-expanded={riskOpen}
            >
              <span>{riskOpen ? '▾' : '▸'}</span>
              Who’s most likely to run short
            </button>
            {riskOpen ? <Blocks blocks={facts.at_risk} /> : null}
          </>
        ) : null}
        {source}
      </FoldCard>
    </>
  );
}

// A run of fact-sheet blocks: list items gathered into one list, the rest as they come.
function Blocks({ blocks }: { blocks: FactBlock[] }) {
  const out: ReactElement[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length)
      out.push(
        <ul key={`list-${out.length}`} className={styles.factList}>
          {items.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>,
      );
    items = [];
  };
  blocks.forEach((block, index) => {
    if (block.kind === 'li') {
      items.push(block.text);
      return;
    }
    flush();
    out.push(
      block.kind === 'h3' ? (
        <h3 key={index} className={styles.factHeading}>
          {block.text}
        </h3>
      ) : (
        <p key={index} className={styles.factText}>
          {block.text}
        </p>
      ),
    );
  });
  flush();
  return <>{out}</>;
}

// --- the ranking -----------------------------------------------------------------------

// Every USDA food ranked by one nutrient: per 100 g, or per 100 kcal (nutrient density).
function FoodRanking({ nutrientKey, label, mine }: { nutrientKey: string; label: string; mine: Set<number> }) {
  const [per, setPer] = useState<RankPer>(nutrientKey === 'energy' ? '100g' : '100kcal');
  const [limit, setLimit] = useState(50);
  const [lowHistamine, setLowHistamine] = useState(false);
  const [singleOnly, setSingleOnly] = useSingleFoods();
  const [text, setText] = useState('');
  const [words, setWords] = useState('');
  const { starred, toggle } = useHighlights();
  // A debounce: narrow the list 300 ms after the typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setWords(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const query = useQuery({
    queryKey: ['nutrition', 'rank', nutrientKey, per, words, limit, lowHistamine, singleOnly],
    queryFn: ({ signal }) => rankFoods(nutrientKey, per, words, limit, lowHistamine, singleOnly, signal),
  });
  const unit = query.data?.unit ?? '';
  const perWords = per === '100g' ? 'per 100 g' : 'per 100 kcal';
  const histamineSource = query.data?.histamine_source;

  return (
    <div>
      <div className={styles.rankControls}>
        {nutrientKey !== 'energy' ? (
          <button
            type="button"
            className={`${styles.chip} ${per === '100kcal' ? styles.chipOn : ''}`}
            onClick={() => setPer('100kcal')}
          >
            Per 100 kcal
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.chip} ${per === '100g' ? styles.chipOn : ''}`}
          onClick={() => setPer('100g')}
        >
          Per 100 g
        </button>
        <button
          type="button"
          className={`${styles.chip} ${lowHistamine ? styles.chipOn : ''}`}
          aria-pressed={lowHistamine}
          disabled={histamineSource ? !histamineSource.loaded : false}
          onClick={() => setLowHistamine(!lowHistamine)}
        >
          Low histamine only
        </button>
        <SingleFoodsChip on={singleOnly} onChange={setSingleOnly} />
        <input
          className={styles.searchInput}
          placeholder="Narrow by name — e.g. raw, beef"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <p className={styles.note}>
        {label} {perWords}, richest first, across every USDA food.
        {per === '100kcal'
          ? ' Per 100 kcal is density: how much you get for the calories. Foods under 5 kcal per 100 g are left out.'
          : ' Dried spices and powders lead by weight; narrow by name to compare what you’d eat.'}{' '}
        Foods with no figure for it aren’t listed. “Single foods only” keeps plain foods you could buy as
        themselves (milk, potatoes, rice, kale), raw or cooked. Tap ☆ to star a food you’re interested in.
      </p>
      {histamineSource ? <HistamineNote source={histamineSource} lowOnly={lowHistamine} /> : null}
      {query.isLoading ? (
        <p className={styles.muted}>Ranking&hellip;</p>
      ) : query.isError ? (
        <p className={styles.error}>{(query.error as Error).message}</p>
      ) : (
        <>
          <ol className={styles.results}>
            {(query.data?.foods ?? []).map((food, index) => (
              <li
                key={food.fdc_id}
                className={`${styles.rankRow} ${starred.has(food.fdc_id) ? styles.rankRowStarred : ''}`}
              >
                <span className={styles.rankNumber}>{index + 1}</span>
                <span className={styles.rankName}>
                  <a href={fdcFoodUrl(food.fdc_id)} target="_blank" rel="noreferrer">
                    {food.description}
                  </a>
                  <span className={styles.resultTag}> · {DATASET_TAGS[food.data_type]}</span>
                  {mine.has(food.fdc_id) ? <span className={styles.rankMine}>in your day</span> : null}
                  <HistamineTag rating={food.histamine} />
                </span>
                <span className={styles.rankAmount}>
                  {formatAmount(food.amount)} {unit}
                </span>
                <StarButton
                  food={food}
                  on={starred.has(food.fdc_id)}
                  onToggle={(picked) => toggle.mutate(picked)}
                />
              </li>
            ))}
          </ol>
          {!query.data?.foods.length ? (
            <p className={styles.muted}>
              {lowHistamine || singleOnly ? 'No food here that passes the filters has a figure for it.' : 'No food by that name has a figure for it.'}
            </p>
          ) : null}
          {query.data && query.data.foods.length === limit && limit < 500 ? (
            <button type="button" className={styles.chip} onClick={() => setLimit(limit + 100)}>
              Show more
            </button>
          ) : null}
        </>
      )}
      {toggle.isError ? <p className={styles.error}>{(toggle.error as Error).message}</p> : null}
    </div>
  );
}

// Which low-histamine list the tags follow, and its cautions, said once above the list.
function HistamineNote({ source, lowOnly }: { source: HistamineSource; lowOnly: boolean }) {
  if (!source.loaded) {
    return (
      <p className={styles.note}>
        The low-histamine list (SIGHI) hasn’t been fetched on this install — run <code>python3 histamine.py</code>.
      </p>
    );
  }
  return (
    <p className={styles.note}>
      Histamine tags follow one list, the{' '}
      <a href={source.url} target="_blank" rel="noreferrer">
        {source.name}
      </a>{' '}
      ({source.publisher}, {source.edition}): 0 well tolerated, 1 moderately, 2 incompatible, 3 very poorly. Lists
      disagree; this is the most detailed free one. Foods are matched by name — the SIGHI entry matched is shown —
      and canned, smoked, cured, pickled or fermented foods are marked avoid, from SIGHI’s{' '}
      <a href={source.leaflet_url} target="_blank" rel="noreferrer">
        leaflet
      </a>
      . Tolerance is individual and freshness matters.
      {lowOnly ? ' Showing only foods SIGHI rates 0; foods not on the list are left out.' : ''}
    </p>
  );
}

const VERDICT_WORDS: Record<HistamineRating['verdict'], string> = {
  low: 'low histamine',
  moderate: 'moderate histamine',
  high: 'histamine: avoid',
  unclear: 'histamine: unclear',
  avoid: 'histamine: avoid',
};

// One food's SIGHI rating, with the list entry it matched; "not on list" when none did.
function HistamineTag({ rating }: { rating: HistamineRating | null }) {
  if (!rating) return <span className={`${styles.histTag} ${styles.hist_none}`}>not on SIGHI list</span>;
  return (
    <span className={`${styles.histTag} ${styles[`hist_${rating.verdict}`] ?? ''}`}>
      {VERDICT_WORDS[rating.verdict]}
      {rating.rating ? ` (${rating.rating})` : ''} · {rating.sighi_name}
      {rating.remark ? ` — ${rating.remark}` : ''}
    </span>
  );
}
