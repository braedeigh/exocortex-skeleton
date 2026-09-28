/**
 * ExposureCard.tsx — the pesticide residues card on a food's page: the
 * computed buy-organic verdict, and every contaminant tested with its values.
 *
 * What this file does: shows the food's exposure score from USDA's Pesticide
 * Data Program samples scored against EPA's chronic safe daily doses
 * (exposure.py, method dri-v1). The headline is the most recent year PDP
 * tested the food, conventional samples, with the sample count; organic
 * samples from the same year sit beside it. Chips pick which samples
 * (conventional, organic, all) and which years to combine — a new choice is
 * computed on the server there and then. Below: every pesticide found, each
 * with how often, how much, and its share of the safe dose, linking to its
 * contaminant page; the ones with no EPA dose (with EPA's own words where it
 * says no chronic limit is needed — shown, but still open); the ones tested and never
 * found; and any numbers her studies hold about this food (hazard_measures).
 * The method and its honest limit close the card.
 *
 * Server: routes/exposure.py (GET /api/exposure/food, POST
 * /api/exposure/food/score). Shapes: ./types.ts; words: ./exposureMath.ts.
 * Used by features/research/FoodPage.tsx. Design: docs/exposure.md.
 *
 * Prompt that produced this file: "this scoring is fine, but i want any
 * possible contaminant to be listed with potential values next to any of
 * them, and be able to click into those contaminants to learn more about them
 * and see how harmful they might be."
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { OrganicVerdict } from '../kitchen/types';
import { getFoodExposure, scoreFood } from './api';
import { barWidth, orderTerms, residueWords, shareWords, termBand, yearsWords } from './exposureMath';
import type { ExposureMethod, ExposureScore, ExposureTerm, FoodExposure, SampleClaim, StudyMeasure } from './types';
import styles from './Exposure.module.css';

export const BAND_CLASS: Record<OrganicVerdict, string> = {
  organic: styles.bandOrganic,
  some: styles.bandSome,
  conventional: styles.bandClear,
  open: styles.bandOpen,
};

const CLAIM_WORDS: Record<SampleClaim, string> = {
  conventional: 'Conventional',
  organic: 'Organic',
  all: 'All samples',
};

export function ExposureCard({ name }: { name: string }) {
  const query = useQuery({
    queryKey: ['exposure', 'food', name],
    queryFn: ({ signal }) => getFoodExposure(name, signal),
  });
  const food = query.data?.food;
  const method = query.data?.method;

  if (query.isLoading) return null;
  if (!food || !method || !food.years.length) {
    return (
      <section className={styles.card}>
        <div className={styles.cardHead}>Pesticide residues · USDA samples</div>
        <p className={styles.muted}>
          No USDA residue samples have been pulled for this food yet
          {food && !food.codes.length ? ' — it has no USDA PDP code' : ''}.
        </p>
      </section>
    );
  }
  return <ExposureBody food={food} method={method} name={name} />;
}

function ExposureBody({ food, method, name }: { food: FoodExposure; method: ExposureMethod; name: string }) {
  const latest = food.years[0];
  const [claim, setClaim] = useState<SampleClaim>('conventional');
  const [years, setYears] = useState<string[]>([latest]);
  const yearsKey = [...years].sort().join(',');
  const stored = yearsKey === latest ? food.headline[claim] : undefined;

  // A choice the headline doesn't already hold is computed on the server.
  const chosen = useQuery({
    queryKey: ['exposure', 'score', name, claim, yearsKey],
    queryFn: () => scoreFood(name, years.map(Number), claim).then((body) => body.score),
    enabled: !stored && years.length > 0,
  });
  const score = stored ?? chosen.data;
  const conventional = food.headline.conventional;
  const organic = food.headline.organic;

  const toggleYear = (year: string) =>
    setYears((current) =>
      current.includes(year) ? (current.length > 1 ? current.filter((each) => each !== year) : current) : [...current, year],
    );

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Pesticide residues · USDA samples</div>

      {conventional ? <Headline score={conventional} method={method} organic={organic} /> : null}

      <div className={styles.chipRow} role="group" aria-label="Which samples">
        {(['conventional', 'organic', 'all'] as SampleClaim[]).map((each) => (
          <button
            key={each}
            type="button"
            className={`${styles.chip} ${claim === each ? styles.chipOn : ''}`}
            onClick={() => setClaim(each)}
          >
            {CLAIM_WORDS[each]}
          </button>
        ))}
      </div>
      {food.years.length > 1 ? (
        <div className={styles.chipRow} role="group" aria-label="Which years">
          {food.years.map((year) => (
            <button
              key={year}
              type="button"
              className={`${styles.chip} ${years.includes(year) ? styles.chipOn : ''}`}
              onClick={() => toggleYear(year)}
            >
              {year}
            </button>
          ))}
        </div>
      ) : null}

      {chosen.isFetching && !stored ? <p className={styles.muted}>Working it out from the samples&hellip;</p> : null}
      {chosen.isError && !stored ? <p className={styles.muted}>Couldn’t compute that: {String(chosen.error)}</p> : null}
      {score ? <ScoreWorking score={score} method={method} /> : null}

      {food.measures.length ? <StudyNumbers measures={food.measures} /> : null}

      <p className={styles.method}>
        How this is worked out: for each pesticide, the average residue over every sample tested (a sample where
        it wasn’t found counts as zero), times one serving ({score?.reference.serving_g ?? '—'} g, two-thirds of
        FDA’s reference amount), divided by a {method.body_kg} kg child’s weight and by EPA’s chronic safe daily
        dose. Over {method.bands[0][0]} of the safe dose → buy organic; over {method.bands[1]?.[0]} → organic helps
        some. This measures exposure against a safety reference, not health outcomes. Source: Benbrook, Dietary
        Risk Index, Environmental Health 2020.
      </p>
    </section>
  );
}

/** The verdict in one line, with the pesticide that decides it and the organic samples beside it. */
function Headline({ score, method, organic }: { score: ExposureScore; method: ExposureMethod; organic?: ExposureScore }) {
  const top = score.terms ? orderTerms(score.terms)[0] : undefined;
  const organicTop = organic?.terms ? orderTerms(organic.terms)[0] : undefined;
  return (
    <div className={styles.headline}>
      <div className={`${styles.verdictLine} ${BAND_CLASS[score.verdict]}`}>{method.verdicts[score.verdict]}</div>
      <p className={styles.headlineText}>
        Conventional samples, {yearsWords(score.years)} · {score.sample_count} tested.
        {top && top.samples_detected && top.dri !== null ? (
          <>
            {' '}
            Largest: <b>{top.pesticide}</b>, {shareWords(top.dri)} per serving.
          </>
        ) : null}
        {score.no_dose_count ? ` ${score.no_dose_count} pesticides found have no EPA safe dose to compare.` : ''}
      </p>
      {organic ? (
        <p className={styles.headlineText}>
          Organic samples, {yearsWords(organic.years)} · {organic.sample_count} tested:{' '}
          {organic.detected_count
            ? `${organic.detected_count} pesticides found; largest ${organicTop?.pesticide ?? ''} at ${shareWords(organic.max_dri)}.`
            : 'no pesticide found.'}
          {organic.sample_count < 30 ? ' Few samples — read it as a hint, not a measurement.' : ''}
        </p>
      ) : null}
    </div>
  );
}

/** The working behind one score: every pesticide, found ones first. */
function ScoreWorking({ score, method }: { score: ExposureScore; method: ExposureMethod }) {
  const terms = orderTerms(score.terms ?? []);
  const found = terms.filter((term) => term.samples_detected);
  const neverFound = terms.filter((term) => !term.samples_detected);
  const line = score.reference.organic_line;
  return (
    <div className={styles.working}>
      <p className={styles.summaryLine}>
        <span className={BAND_CLASS[score.verdict]}>{method.verdicts[score.verdict]}</span> ·{' '}
        {CLAIM_WORDS[score.claim].toLowerCase()} · {yearsWords(score.years)} · {score.sample_count} samples ·{' '}
        {score.detected_count} of {score.pesticide_count} pesticides found
      </p>
      <p className={styles.muted}>
        {line.samples_over} of {score.sample_count} samples had a residue over{' '}
        {Math.round(line.share_of_tolerance * 100)}% of its EPA legal limit — the line food sold as organic may not
        cross.
      </p>
      <ul className={styles.termList}>
        {found.map((term) => (
          <TermRow key={term.pesticide_code} term={term} method={method} />
        ))}
      </ul>
      {neverFound.length ? (
        <details className={styles.neverFound}>
          <summary>Tested for and never found ({neverFound.length})</summary>
          <p className={styles.muted}>{neverFound.map((term) => term.pesticide).join(' · ')}</p>
        </details>
      ) : null}
    </div>
  );
}

function TermRow({ term, method }: { term: ExposureTerm; method: ExposureMethod }) {
  const band = termBand(term, method.bands);
  const nameLink =
    term.hazard_id !== null ? (
      <Link to="/food/contaminants/$id" params={{ id: String(term.hazard_id) }} className={styles.termName}>
        {term.pesticide}
      </Link>
    ) : (
      <span className={styles.termName}>{term.pesticide}</span>
    );
  return (
    <li className={styles.termRow}>
      <div className={styles.termTop}>
        {nameLink}
        <span className={`${styles.termShare} ${BAND_CLASS[band]}`}>{shareWords(term.dri)}</span>
      </div>
      <div className={styles.bar} aria-hidden="true">
        <span className={`${styles.barFill} ${BAND_CLASS[band]}`} style={{ width: `${barWidth(term.dri)}%` }} />
      </div>
      <div className={styles.termDetail}>
        found in {term.samples_detected} of {term.samples_tested} · average {residueWords(term.mean_ppb)} · highest{' '}
        {residueWords(term.max_ppb)}
        {term.dose !== null ? ` · EPA safe dose ${term.dose} mg/kg/day` : ''}
      </div>
      {/* EPA's own words where it sets no chronic limit: shown, but the verdict
          stays open until independent studies say the same. */}
      {term.no_chronic_limit ? (
        <div className={styles.termDetail}>
          EPA sets no chronic limit: &ldquo;{term.no_chronic_limit.value}&rdquo;
          {term.no_chronic_limit.url ? (
            <>
              {' '}
              <a href={term.no_chronic_limit.url} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          ) : null}{' '}
          — not taken on trust: still open until independent studies are checked.
        </div>
      ) : null}
    </li>
  );
}

/** Numbers her studies hold about this food — metals, detection rates — each with its source. */
function StudyNumbers({ measures }: { measures: StudyMeasure[] }) {
  return (
    <div className={styles.working}>
      <div className={styles.subHead}>From studies</div>
      <ul className={styles.termList}>
        {measures.map((measure) => (
          <li key={measure.id} className={styles.termRow}>
            <div className={styles.termTop}>
              <Link to="/food/contaminants/$id" params={{ id: String(measure.hazard_id) }} className={styles.termName}>
                {measure.hazard}
              </Link>
              <span className={styles.termShare}>
                {measure.amount} {measure.unit}
              </span>
            </div>
            <div className={styles.termDetail}>
              {measure.measure.replace('_', ' ')}
              {measure.year ? ` · ${measure.year}` : ''}
              {measure.sample_size ? ` · ${measure.sample_size} samples` : ''}
              {measure.source ? (
                <>
                  {' · '}
                  {measure.source_url ? (
                    <a href={measure.source_url} target="_blank" rel="noreferrer">
                      {measure.source}
                    </a>
                  ) : (
                    measure.source
                  )}
                </>
              ) : null}
              {' · '}
              {measure.review === 'unreviewed' ? 'not reviewed yet' : `you ${measure.review} this`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
