/**
 * FoodPage.tsx — a page per food under Research: should I buy it organic, and
 * what do my studies say?
 *
 * What this file does: two pages. FoodPage (/research/foods/<name>) is one
 * food's profile: where it comes from (every map source linked to the food or
 * one of its products, with its honest labels and where that information came
 * from, each opening on the map), the research verdict with its reasoning, Claude's estimate with its
 * qualifiers, the contaminants it names, and her confirm/dispute; then every
 * claim and measurement her research tables hold about the food, each linking
 * to the claim on the Claims page and out to the original studies. FoodsIndex
 * (/research/foods) lists every food in the catalog with what's known, known
 * ones first. The grocery list's popup (features/kitchen/OrganicVerdict.tsx)
 * opens FoodPage.
 *
 * Server: routes/food.py (GET /api/food/page — its `sources` come from
 * sourcestore.for_food —, /api/food/pages, POST
 * /api/food/estimates/<id>/review) → estimatestore.py. Shapes live in the
 * kitchen feature's types.ts, since the grocery list reads the same rows.
 *
 * Prompt that produced this file: "I want for every food item to have its own
 * page on the research section that the popup ports into." The sources card:
 * "i want to be able to identify where foods are from and create profiles of
 * any food."
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { getFoodIndex, getFoodPage, reviewEstimate } from '../kitchen/api';
import type {
  EvidenceClaim,
  EvidenceMeasure,
  EvidenceSource,
  FoodPageData,
  OrganicVerdict,
  VerdictReview,
} from '../kitchen/types';
import { ECO_ORIGIN, geoSourceInfo, metaLabel, originOf, txInfo } from '../ecosystem/axes';
import pageStyles from './ResearchPage.module.css';
import styles from './FoodPage.module.css';

const VERDICT_CLASS: Record<OrganicVerdict, string> = {
  organic: styles.verdictOrganic,
  some: styles.verdictSome,
  conventional: styles.verdictConventional,
  open: styles.verdictOpen,
};

const REVIEW_WORDS: Record<VerdictReview, string> = {
  unreviewed: 'not reviewed yet',
  confirmed: 'you confirmed this',
  disputed: 'you disputed this',
};

// --- one food ------------------------------------------------------------------

export function FoodPage({ name }: { name: string }) {
  const query = useQuery({ queryKey: ['research', 'food-page', name], queryFn: ({ signal }) => getFoodPage(name, signal) });
  const page = query.data;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>{page?.name ?? name}</h1>
        <span className={pageStyles.pageSub}>where it comes from · buy organic or not</span>
        <Link to="/research/foods" className={pageStyles.pageHeadLink} title="Every food">
          All foods
        </Link>
      </div>
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : query.isError || !page ? (
        <div className={styles.note}>Could not load this food.</div>
      ) : (
        <>
          {!page.food ? <div className={styles.note}>This name isn’t in your food catalog yet, so it has no verdict or guess.</div> : null}
          <SourcesCard page={page} />
          <ResearchVerdictCard page={page} />
          <EstimateCard page={page} />
          <EvidenceCard page={page} />
        </>
      )}
    </div>
  );
}

/** Where it comes from: every map source this food (or a product of it) is
 * linked to, each with its honest labels and origin record, opening on the
 * map. An untraced food says so and offers the map, where it can be placed. */
function SourcesCard({ page }: { page: FoodPageData }) {
  if (!page.food) return null;
  const sources = page.sources || [];
  const foodId = page.food.id;
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Where it comes from</div>
      {sources.length ? (
        <ul className={styles.list}>
          {sources.map((source) => {
            const tx = txInfo(source);
            const geo = geoSourceInfo(source);
            const origin = ECO_ORIGIN[originOf(source)];
            const products = (source.links || []).filter((l) => l.food_id === foodId && l.product_name);
            return (
              <li key={source.id} className={styles.listItem}>
                <div className={styles.evidenceText}>
                  <span
                    style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: tx.color, marginRight: 6 }}
                  />
                  <Link to="/ecosystem" search={{ source: source.id }} className={styles.sourceLink}>
                    {source.name}
                  </Link>
                </div>
                <div className={styles.meta}>
                  {tx.label} · {geo.icon} {geo.label} · {metaLabel(source)}
                </div>
                <div className={styles.meta}>
                  {origin.icon} {origin.label}
                  {source.origin_date ? ` · looked up ${source.origin_date}` : ''}
                  {source.origin_detail ? ` — ${source.origin_detail}` : ''}
                </div>
                {products.length ? (
                  <div className={styles.meta}>for {products.map((l) => l.product_name).join(', ')}</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.meta}>Not traced yet — no source on the map is linked to this food.</div>
      )}
      <Link to="/ecosystem" search={{ food: foodId }} className={styles.linkBtn}>
        {sources.length ? 'Show on the map →' : 'Place it on the map →'}
      </Link>
    </section>
  );
}

/** Her research verdict, when there is one — it outranks the guess. */
function ResearchVerdictCard({ page }: { page: FoodPageData }) {
  const research = page.research;
  if (!research) return null;
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Your research</div>
      <div className={`${styles.verdictLine} ${VERDICT_CLASS[research.verdict]}`}>{page.vocab.verdicts[research.verdict]}</div>
      {research.reasoning ? <p className={styles.summary}>{research.reasoning}</p> : null}
      <div className={styles.meta}>
        rests on {research.grounds} measurement{research.grounds === 1 ? '' : 's'} · {REVIEW_WORDS[research.review]}
      </div>
      <Link to="/research/tables" search={{ verdict: research.id }} className={styles.linkBtn}>
        Open the verdict in Tables →
      </Link>
    </section>
  );
}

/** Claude's estimate in full: why, qualifiers, other contaminants, and her
 * review. Tapping the mark she already gave takes it back. */
function EstimateCard({ page }: { page: FoodPageData }) {
  const queryClient = useQueryClient();
  const review = useMutation({
    mutationFn: ({ id, mark }: { id: number; mark: VerdictReview }) => reviewEstimate(id, mark),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['research', 'food-page'] });
      void queryClient.invalidateQueries({ queryKey: ['kitchen', 'list-verdicts'] });
    },
  });
  const estimate = page.estimate;
  if (!page.food) return null;
  if (!estimate) {
    return (
      <section className={styles.card}>
        <div className={styles.cardHead}>Claude’s guess</div>
        <div className={styles.meta}>Not estimated yet. Add it to the grocery list and tap “Estimate” there.</div>
      </section>
    );
  }
  const used = estimate.claims.length;
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Claude’s guess</div>
      <div className={`${styles.verdictLine} ${VERDICT_CLASS[estimate.verdict]}`}>
        ≈ {page.vocab.verdicts[estimate.verdict]}
        <span className={styles.confidence}> · {estimate.confidence} confidence</span>
      </div>
      <p className={styles.summary}>{estimate.summary}</p>
      {used ? (
        <div className={styles.meta}>
          drew on {used} of your claims below
        </div>
      ) : null}
      {estimate.qualifiers.length ? (
        <div className={styles.qualifiers}>
          {estimate.qualifiers.map((key) => (
            <span key={key} className={styles.qualifier}>
              {page.vocab.qualifiers[key] ?? key}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.subHead}>What else gets into it</div>
      {estimate.contaminants.length ? (
        <ul className={styles.list}>
          {estimate.contaminants.map((c) => (
            <li key={c.name} className={styles.listItem}>
              <div>
                <b>{c.name}</b> — {c.known}
              </div>
              <div className={styles.meta}>
                organic helps: {c.organic_helps} · evidence: {c.evidence}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.meta}>Nothing beyond pesticide residue is known to be a particular concern here.</div>
      )}
      <div className={styles.reviewRow}>
        <span className={styles.meta}>{REVIEW_WORDS[estimate.review]}</span>
        {(['confirmed', 'disputed'] as const).map((mark) => (
          <button
            key={mark}
            type="button"
            className={`${styles.reviewBtn} ${estimate.review === mark ? styles.reviewBtnOn : ''}`}
            disabled={review.isPending}
            onClick={() => review.mutate({ id: estimate.id, mark: estimate.review === mark ? 'unreviewed' : mark })}
          >
            {mark === 'confirmed' ? 'Confirm' : 'Dispute'}
          </button>
        ))}
      </div>
      <div className={styles.footnote}>
        From the model’s general knowledge and the claims below, not from its own measurements. Its confidence is its own rough
        sense, not a probability.
      </div>
    </section>
  );
}

/** Every claim and measurement her tables hold about the food, each with its studies. */
function EvidenceCard({ page }: { page: FoodPageData }) {
  const usedByGuess = page.estimate?.claims ?? [];
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>Claims and studies</div>
      {!page.claims.length && !page.measures.length ? (
        <>
          <div className={styles.meta}>Nothing in your research tables about this food yet.</div>
          <Link to="/research/claims" search={{}} className={styles.linkBtn}>
            Your claims →
          </Link>
        </>
      ) : (
        <ul className={styles.list}>
          {page.claims.map((claim) => (
            <ClaimRow key={claim.id} claim={claim} name={page.name} used={usedByGuess.includes(claim.id)} />
          ))}
          {page.measures.map((measure) => (
            <MeasureRow key={measure.id} measure={measure} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One claim: its sentence, its figures (naming a stand-in food), her review,
 * its studies, and a link to it on the Claims page. */
function ClaimRow({ claim, name, used }: { claim: EvidenceClaim; name: string; used: boolean }) {
  const unreviewed = claim.author === 'llm' && !claim.reviewed;
  return (
    <li className={styles.listItem}>
      <div className={styles.evidenceText}>{claim.text}</div>
      {claim.values.map((value, index) => (
        <div key={index} className={styles.meta}>
          {value.measure}
          {value.amount != null ? ` · ${value.amount} ${value.unit}` : ''}
          {value.year ? ` · ${value.year}` : ''}
          {value.subject.toLowerCase() !== name.toLowerCase() ? ` · measured on ${value.subject}` : ''}
        </div>
      ))}
      <div className={styles.meta}>
        {claim.verdict ? `you marked it ${claim.verdict}` : unreviewed ? 'found by an agent, not reviewed yet' : ''}
        {used ? <span className={styles.usedTag}>Claude’s guess used this</span> : null}
      </div>
      <SourceLinks sources={claim.sources} />
      <Link to="/research/claims" search={{ claim: claim.id }} className={styles.linkBtn}>
        Open the claim →
      </Link>
    </li>
  );
}

function MeasureRow({ measure }: { measure: EvidenceMeasure }) {
  return (
    <li className={styles.listItem}>
      <div className={styles.evidenceText}>
        {measure.hazard}: {measure.amount} {measure.unit}
        {measure.year ? ` (${measure.year})` : ''}
      </div>
      <div className={styles.meta}>
        {measure.measured_on ? `measured on ${measure.measured_on} · ` : ''}
        {REVIEW_WORDS[measure.review]}
      </div>
      <SourceLinks sources={measure.sources} />
    </li>
  );
}

/** The studies themselves: each opens the original in a new tab. A source
 * that argues against the claim says so. */
function SourceLinks({ sources }: { sources: EvidenceSource[] }) {
  if (!sources.length) return <div className={styles.meta}>no study linked</div>;
  return (
    <div className={styles.sources}>
      {sources.map((source) =>
        source.url ? (
          <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
            {source.stance === 'contradicts' ? 'against: ' : ''}
            {source.title} ↗
          </a>
        ) : (
          <span key={source.id} className={styles.meta}>
            {source.title}
          </span>
        ),
      )}
    </div>
  );
}

// --- every food ------------------------------------------------------------------

/** Every food in the catalog, known ones first, with a filter box. */
export function FoodsIndex() {
  const query = useQuery({ queryKey: ['research', 'food-index'], queryFn: ({ signal }) => getFoodIndex(signal) });
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const foods = (query.data?.foods ?? []).filter((food) => !needle || food.name.toLowerCase().includes(needle));

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Foods</h1>
        <span className={pageStyles.pageSub}>buy organic or not, food by food</span>
        <Link to="/research/claims" search={{}} className={pageStyles.pageHeadLink} title="The claims table">
          &#9776; Claims
        </Link>
      </div>
      <input
        className={styles.filter}
        placeholder="Find a food"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label="Find a food"
      />
      {query.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : query.isError ? (
        <div className={styles.note}>Could not load your foods.</div>
      ) : (
        <ul className={styles.indexList}>
          {foods.map((food) => {
            const verdict = food.research ?? food.estimate?.verdict ?? null;
            return (
              <li key={food.id}>
                <Link to="/research/foods/$name" params={{ name: food.name }} className={styles.indexRow}>
                  <span className={styles.indexName}>{food.name}</span>
                  {verdict ? (
                    <span className={`${styles.indexVerdict} ${VERDICT_CLASS[verdict]}`}>
                      {food.research ? '' : '≈ '}
                      {query.data!.verdicts[verdict]}
                    </span>
                  ) : null}
                  {food.evidence ? (
                    <span className={styles.meta}>
                      {food.evidence} finding{food.evidence === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
