/**
 * ContaminantPage.tsx — a page per contaminant: what it is, how harmful it
 * might be, and every food it was found in.
 *
 * What this file does: two pages in the Food area. ContaminantPage
 * (/food/contaminants/<id>) shows one contaminant — a pesticide found in USDA
 * samples, or a metal from her studies. First the facts about it, harm first
 * (EPA's chronic and acute safe doses, cancer figures, health effects), each
 * saying where it was read, who wrote it (a loader reading a published table,
 * an agent, or her) and her review, with Confirm and Dispute. A disputed safe
 * dose is never used to score. Then whether anything beyond the agencies
 * (independent studies) is on file — until it is, the page says it needs more
 * research. Then every food it was found in, with how
 * often, how much and its share of the safe dose per serving, and the study
 * numbers about it. ContaminantsIndex (/food/contaminants) lists every
 * contaminant with facts or findings, the most concerning first.
 *
 * Server: routes/exposure.py (GET /api/exposure/contaminants[/<id>], POST
 * /api/exposure/facts/<id>/review) → exposurestore.py. Shapes: ./types.ts.
 * Linked from ExposureCard.tsx's rows. Design: docs/exposure.md.
 *
 * Prompt that produced this file: "be able to click into those contaminants
 * to learn more about them and see how harmful they might be."
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FoodNav } from '../ecosystem/FoodNav';
import type { VerdictReview } from '../kitchen/types';
import pageStyles from '../research/ResearchPage.module.css';
import { getContaminant, getContaminants, reviewFact } from './api';
import { BAND_CLASS } from './ExposureCard';
import { residueWords, shareWords, termBand, yearsWords } from './exposureMath';
import type { ContaminantFact, ContaminantFinding, ExposureMethod } from './types';
import styles from './Exposure.module.css';

// Harm first: the facts that say how dangerous it is lead the list.
const HARM_FACTS = [
  'chronic_dose',
  'no_chronic_limit',
  'acute_dose',
  'cancer_rating',
  'cancer_slope',
  'reference_level',
  'health_effect',
];

const AUTHOR_WORDS: Record<ContaminantFact['author'], string> = {
  code: 'read from a published table',
  llm: 'written by an agent',
  owner: 'written by you',
};

const REVIEW_WORDS: Record<VerdictReview, string> = {
  unreviewed: 'not reviewed yet',
  confirmed: 'you confirmed this',
  disputed: 'you disputed this — not used',
};

// --- one contaminant -------------------------------------------------------------

export function ContaminantPage({ id }: { id: number }) {
  const query = useQuery({
    queryKey: ['exposure', 'contaminant', id],
    queryFn: ({ signal }) => getContaminant(id, signal),
  });
  const contaminant = query.data?.contaminant;
  const method = query.data?.method;
  const harm = contaminant?.facts.filter((fact) => HARM_FACTS.includes(fact.fact)) ?? [];
  const independent = contaminant?.facts.filter((fact) => fact.fact === 'independent_evidence') ?? [];
  const other =
    contaminant?.facts.filter((fact) => !HARM_FACTS.includes(fact.fact) && fact.fact !== 'independent_evidence') ??
    [];

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>{contaminant?.name ?? 'Contaminant'}</h1>
        <span className={pageStyles.pageSub}>{contaminant?.parents.join(' · ') || 'contaminant'}</span>
      </div>
      <FoodNav current="contaminants" />
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : !contaminant || !method ? (
        <p className={styles.muted}>Could not load this contaminant.</p>
      ) : (
        <>
          {contaminant.note ? <p className={styles.headlineText}>{contaminant.note}</p> : null}
          <section className={styles.card}>
            <div className={styles.cardHead}>How harmful it might be</div>
            {harm.length ? (
              <FactList facts={harm} contaminantId={id} />
            ) : (
              <p className={styles.muted}>
                No safe dose or health fact on file yet. Until one is, any food it’s found in is an open question.
              </p>
            )}
          </section>
          {/* Checked past the agencies: every contaminant needs research until
              a study outside EPA/IRIS/ATSDR is on file. */}
          <section className={styles.card}>
            <div className={styles.cardHead}>
              {contaminant.research.needs_research ? 'Needs more research' : 'Checked beyond the agencies'}
            </div>
            {independent.length ? (
              <FactList facts={independent} contaminantId={id} />
            ) : (
              <p className={styles.muted}>
                Only agency figures so far. Independent studies — in vitro, animal, human — haven’t been combed
                through yet, so nothing above is taken as settled.
              </p>
            )}
          </section>
          <section className={styles.card}>
            <div className={styles.cardHead}>Where it’s found</div>
            {contaminant.found_in.length || contaminant.measures.length ? (
              <FoundIn findings={contaminant.found_in} method={method} />
            ) : (
              <p className={styles.muted}>Not found in any food scored so far.</p>
            )}
            {contaminant.measures.length ? (
              <ul className={styles.termList}>
                {contaminant.measures.map((measure) => (
                  <li key={measure.id} className={styles.termRow}>
                    <div className={styles.termTop}>
                      <Link to="/food/foods/$name" params={{ name: measure.food }} className={styles.termName}>
                        {measure.food}
                      </Link>
                      <span className={styles.termShare}>
                        {measure.amount} {measure.unit}
                      </span>
                    </div>
                    <div className={styles.termDetail}>
                      from a study{measure.year ? `, ${measure.year}` : ''}
                      {measure.source ? ` · ${measure.source}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          {other.length ? (
            <section className={styles.card}>
              <div className={styles.cardHead}>What it is</div>
              <FactList facts={other} contaminantId={id} />
            </section>
          ) : null}
          {contaminant.names.length > 1 ? (
            <p className={styles.muted}>Also written as: {contaminant.names.join(' · ')}</p>
          ) : null}
          <p className={styles.method}>
            A safe dose is EPA’s chronic reference dose (or, where the law requires extra protection for children,
            the population-adjusted dose): the amount a person could take in every day for a lifetime without
            expected harm. Being under it is not proof of no effect, and being over it is not proof of harm — it is
            the line regulators use.
          </p>
        </>
      )}
    </div>
  );
}

function FactList({ facts, contaminantId }: { facts: ContaminantFact[]; contaminantId: number }) {
  const client = useQueryClient();
  const review = useMutation({
    mutationFn: ({ id, value }: { id: number; value: VerdictReview }) => reviewFact(id, value),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['exposure', 'contaminant', contaminantId] });
      client.invalidateQueries({ queryKey: ['exposure', 'food'] });
    },
  });
  return (
    <ul className={styles.termList}>
      {facts.map((fact) => (
        <li key={fact.id} className={`${styles.termRow} ${fact.review === 'disputed' ? styles.disputed : ''}`}>
          <div className={styles.termTop}>
            <span className={styles.factLabel}>{fact.label}</span>
            <span className={styles.factValue}>{fact.value}</span>
          </div>
          <div className={styles.termDetail}>
            {fact.basis ? `${fact.basis} · ` : ''}
            {fact.url ? (
              <a href={fact.url} target="_blank" rel="noreferrer">
                source
              </a>
            ) : fact.source_id ? (
              `source ${fact.source_id}`
            ) : (
              'no source'
            )}
            {' · '}
            {AUTHOR_WORDS[fact.author]} · {REVIEW_WORDS[fact.review]}
          </div>
          {fact.note ? <div className={styles.termDetail}>{linkify(fact.note)}</div> : null}
          {fact.author !== 'owner' ? (
            <div className={styles.reviewRow}>
              <button
                type="button"
                className={`${styles.chip} ${fact.review === 'confirmed' ? styles.chipOn : ''}`}
                disabled={review.isPending}
                onClick={() => review.mutate({ id: fact.id, value: fact.review === 'confirmed' ? 'unreviewed' : 'confirmed' })}
              >
                ✓ Confirm
              </button>
              <button
                type="button"
                className={`${styles.chip} ${fact.review === 'disputed' ? styles.chipOn : ''}`}
                disabled={review.isPending}
                onClick={() => review.mutate({ id: fact.id, value: fact.review === 'disputed' ? 'unreviewed' : 'disputed' })}
              >
                ✗ Dispute
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A note with a web address in it gets the address as a link. */
function linkify(text: string) {
  const match = text.match(/https?:\/\/\S+/);
  if (!match || match.index === undefined) return text;
  return (
    <>
      {text.slice(0, match.index)}
      <a href={match[0]} target="_blank" rel="noreferrer">
        {match[0].length > 50 ? `${match[0].slice(0, 50)}…` : match[0]}
      </a>
      {text.slice(match.index + match[0].length)}
    </>
  );
}

function FoundIn({ findings, method }: { findings: ContaminantFinding[]; method: ExposureMethod }) {
  const found = findings.filter((finding) => finding.samples_detected);
  const notFound = findings.length - found.length;
  return (
    <>
      <ul className={styles.termList}>
        {found.map((finding) => {
          const band = termBand(
            {
              pesticide_code: '', pesticide: '', hazard_id: null, dose_fact_id: null, ...finding,
            },
            method.bands,
          );
          return (
            <li key={finding.score_id} className={styles.termRow}>
              <div className={styles.termTop}>
                <Link to="/food/foods/$name" params={{ name: finding.food }} className={styles.termName}>
                  {finding.food}
                </Link>
                <span className={`${styles.termShare} ${BAND_CLASS[band]}`}>{shareWords(finding.dri)}</span>
              </div>
              <div className={styles.termDetail}>
                {finding.claim} · {yearsWords(finding.years)} · found in {finding.samples_detected} of{' '}
                {finding.samples_tested} · average {residueWords(finding.mean_ppb)} · highest{' '}
                {residueWords(finding.max_ppb)}
              </div>
            </li>
          );
        })}
      </ul>
      {notFound ? <p className={styles.muted}>Tested for and not found in {notFound} other scored sample sets.</p> : null}
    </>
  );
}

// --- every contaminant --------------------------------------------------------------

export function ContaminantsIndex() {
  const query = useQuery({ queryKey: ['exposure', 'contaminants'], queryFn: ({ signal }) => getContaminants(signal) });
  const items = [...(query.data?.contaminants ?? [])].sort(
    (a, b) => (b.max_dri ?? -1) - (a.max_dri ?? -1) || b.foods - a.foods || a.name.localeCompare(b.name),
  );
  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Contaminants</h1>
        <span className={pageStyles.pageSub}>what’s been found in your food, most concerning first</span>
      </div>
      <FoodNav current="contaminants" />
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : !items.length ? (
        <p className={styles.muted}>Nothing scored yet.</p>
      ) : (
        <ul className={styles.termList}>
          {items.map((item) => (
            <li key={item.id} className={styles.termRow}>
              <div className={styles.termTop}>
                <Link to="/food/contaminants/$id" params={{ id: String(item.id) }} className={styles.termName}>
                  {item.name}
                </Link>
                <span className={styles.termShare}>
                  {item.max_dri !== null ? `up to ${shareWords(item.max_dri)}` : item.foods ? 'no safe dose to compare' : ''}
                </span>
              </div>
              <div className={styles.termDetail}>
                {item.parents ?? 'contaminant'} · found in {item.foods} food{item.foods === 1 ? '' : 's'} · {item.facts}{' '}
                fact{item.facts === 1 ? '' : 's'} ·{' '}
                {item.independent ? `${item.independent} independent finding${item.independent === 1 ? '' : 's'}` : 'needs research'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
