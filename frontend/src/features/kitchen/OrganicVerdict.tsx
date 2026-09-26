/**
 * OrganicVerdict.tsx — buy organic or not, on each grocery-list row.
 *
 * What this file does: fetches, for every item on the list, the research
 * verdict (numbers-backed, from the research tables) and Claude's estimate
 * (from general knowledge), and draws them. GroceryListCard.tsx puts an
 * OrganicChip on each row; tapping it opens OrganicModal with the why — the
 * summary, the qualifiers, and what else is known to get into that food — plus
 * her confirm/dispute on the estimate. Above that, "Your research" lists every
 * claim and measurement her research tables hold about the food, each linking
 * into the Research page and out to the studies themselves. The EstimateBar
 * above the list starts an estimate run for items with none.
 *
 * A research verdict is drawn solid; an estimate is drawn dashed with "≈" in
 * front, so a guess never looks like research. Server: routes/food.py
 * (list-verdicts, estimates/run, estimates/<id>/review) → estimatestore.py.
 *
 * Prompt that produced this file: "Every item's organic or not should have a
 * popup if you click it with a summary of why. And then you can click from
 * there into the research."
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { getFoodEvidence, getListVerdicts, reviewEstimate, runEstimates } from './api';
import { Modal } from './Modal';
import type { EvidenceClaim, EvidenceMeasure, EvidenceSource, ListVerdictItem, ListVerdicts, OrganicVerdict, VerdictReview } from './types';
import styles from './OrganicVerdict.module.css';

const VERDICTS_KEY = ['kitchen', 'list-verdicts'] as const;

/** Short words a chip shows; the popup uses the full words from the server. */
const CHIP_WORDS: Record<OrganicVerdict, string> = {
  organic: 'organic',
  some: 'some organic',
  conventional: 'conv. ok',
  open: 'open',
};

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

/** The list's verdicts, refetched when the list's names change and every few
 * seconds while an estimate run is going. `names` keys the query so an item
 * she just added gets its chip without waiting for the slow poll. */
export function useListVerdicts(names: string[], enabled: boolean) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const query = useQuery({
    queryKey: [...VERDICTS_KEY, names.join('\u0001')],
    queryFn: ({ signal }) => getListVerdicts(signal),
    enabled,
    placeholderData: (previous) => previous,
    refetchInterval: (current) => (current.state.data?.running || isStarting(startedAt) ? 3000 : 30000),
  });
  // Between her tap and the script taking its lock, the server can't yet say
  // it's running; this bridges those few seconds so the button doesn't flicker back.
  const running = !!query.data?.running || isStarting(startedAt);
  const byName = new Map<string, ListVerdictItem>();
  for (const item of query.data?.items ?? []) byName.set(item.name, item);
  return { data: query.data, byName, running, markStarted: () => setStartedAt(Date.now()) };
}

function isStarting(startedAt: number | null) {
  return startedAt !== null && Date.now() - startedAt < 10000;
}

/** The chip on a grocery row: the research verdict if there is one, else the
 * estimate, else nothing. Tapping opens the popup. */
export function OrganicChip({ item, onOpen }: { item: ListVerdictItem | undefined; onOpen: () => void }) {
  if (!item || item.kind !== 'food') return null;
  const shown = item.research ?? item.estimate;
  // No verdict or guess yet, but her research has something: a quiet chip
  // that still opens the popup, so the studies are one tap away.
  if (!shown) {
    if (!item.evidence) return null;
    return (
      <button type="button" className={`${styles.chip} ${styles.verdictOpen} ${styles.chipGuess}`} title="Your research on this — tap to read" onClick={onOpen}>
        research
      </button>
    );
  }
  const guess = !item.research;
  const disputed = shown.review === 'disputed';
  return (
    <button
      type="button"
      className={`${styles.chip} ${VERDICT_CLASS[shown.verdict]} ${guess ? styles.chipGuess : ''} ${disputed ? styles.chipDisputed : ''}`}
      title={guess ? "Claude's guess — tap for why" : 'From research — tap for why'}
      onClick={onOpen}
    >
      {guess ? '≈ ' : ''}
      {CHIP_WORDS[shown.verdict]}
    </button>
  );
}

/** Above the list: how many items have no estimate yet, and the button that
 * starts a run for them. Says what went wrong in the last run, if anything. */
export function EstimateBar({ data, running, onStarted }: { data: ListVerdicts | undefined; running: boolean; onStarted: () => void }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => runEstimates(),
    onSuccess: () => {
      onStarted();
      void queryClient.invalidateQueries({ queryKey: VERDICTS_KEY });
    },
  });
  if (!data) return null;
  const failures = data.last_run?.finished ? data.last_run.failures : [];
  if (!running && !data.pending && !failures.length) return null;
  return (
    <div className={styles.estimateBar}>
      {running ? (
        <span>Claude is estimating buy-organic-or-not for your list…</span>
      ) : data.pending ? (
        <>
          <span>
            {data.pending} item{data.pending === 1 ? '' : 's'} with no organic estimate yet
          </span>
          <button type="button" className={styles.barBtn} disabled={run.isPending} onClick={() => run.mutate()}>
            Estimate
          </button>
        </>
      ) : null}
      {!running && failures.length ? (
        <span className={styles.barFailures} title={failures.map((f) => `${f.food}: ${f.error}`).join('\n')}>
          {failures.length} couldn’t be estimated last run
        </span>
      ) : null}
      {run.isError ? <span className={styles.barFailures}>Could not start the estimate.</span> : null}
    </div>
  );
}

/** The popup: the research verdict with a link into it, then Claude's
 * estimate with its why, qualifiers and contaminants, and her review of it. */
export function OrganicModal({ item, data, onClose }: { item: ListVerdictItem; data: ListVerdicts; onClose: () => void }) {
  const queryClient = useQueryClient();
  const review = useMutation({
    mutationFn: ({ id, mark }: { id: number; mark: VerdictReview }) => reviewEstimate(id, mark),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: VERDICTS_KEY }),
  });
  const words = data.vocab.verdicts;
  const { research, estimate } = item;

  return (
    <Modal title={item.name} onClose={onClose}>
      {/* Her research: the verdict if there is one (it outranks the guess),
          then every claim and number her tables hold, each with its studies. */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>Your research</div>
        {research ? (
          <>
            <div className={`${styles.verdictLine} ${VERDICT_CLASS[research.verdict]}`}>{words[research.verdict]}</div>
            <div className={styles.meta}>
              rests on {research.grounds} measurement{research.grounds === 1 ? '' : 's'} · {REVIEW_WORDS[research.review]}
            </div>
            <Link to="/research/tables" search={{ verdict: research.id }} className={styles.linkBtn}>
              Open the verdict →
            </Link>
          </>
        ) : null}
        <EvidenceList name={item.name} usedByGuess={estimate?.claims ?? []} />
      </section>

      {/* Claude's estimate: the why, the qualifiers, and what else gets in. */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>Claude’s guess</div>
        {estimate ? (
          <>
            <div className={`${styles.verdictLine} ${VERDICT_CLASS[estimate.verdict]}`}>
              ≈ {words[estimate.verdict]}
              <span className={styles.confidence}> · {estimate.confidence} confidence</span>
            </div>
            <p className={styles.summary}>{estimate.summary}</p>
            {estimate.qualifiers.length ? (
              <div className={styles.qualifiers}>
                {estimate.qualifiers.map((key) => (
                  <span key={key} className={styles.qualifier}>
                    {data.vocab.qualifiers[key] ?? key}
                  </span>
                ))}
              </div>
            ) : null}
            {estimate.contaminants.length ? (
              <>
                <div className={styles.subHead}>What else gets into it</div>
                <ul className={styles.contaminants}>
                  {estimate.contaminants.map((c) => (
                    <li key={c.name} className={styles.contaminant}>
                      <div>
                        <b>{c.name}</b> — {c.known}
                      </div>
                      <div className={styles.meta}>
                        organic helps: {c.organic_helps} · evidence: {c.evidence}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className={styles.meta}>Nothing beyond pesticide residue is known to be a particular concern here.</div>
            )}
            {/* Her review: tapping the mark she already gave takes it back. */}
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
              From the model’s general knowledge, not from measurements. Its confidence is its own rough sense, not a
              probability.
            </div>
          </>
        ) : (
          <div className={styles.meta}>Not estimated yet — use “Estimate” above the list.</div>
        )}
      </section>
    </Modal>
  );
}

/** Every claim and measurement her tables hold about one food, fetched when
 * the popup opens. Each claim links to itself on the Claims page and out to
 * each study it rests on; a figure measured on a stand-in says so. */
function EvidenceList({ name, usedByGuess }: { name: string; usedByGuess: string[] }) {
  const query = useQuery({ queryKey: ['kitchen', 'evidence', name], queryFn: ({ signal }) => getFoodEvidence(name, signal) });
  if (query.isLoading) return <div className={styles.meta}>Loading your research…</div>;
  if (query.isError || !query.data) return <div className={styles.meta}>Could not load your research.</div>;
  const { claims, measures } = query.data;
  if (!claims.length && !measures.length) {
    return (
      <>
        <div className={styles.meta}>Nothing in your research tables about this food yet.</div>
        <Link to="/research/claims" search={{}} className={styles.linkBtn}>
          Your claims →
        </Link>
      </>
    );
  }
  return (
    <ul className={styles.evidence}>
      {claims.map((claim) => (
        <ClaimRow key={claim.id} claim={claim} name={name} used={usedByGuess.includes(claim.id)} />
      ))}
      {measures.map((measure) => (
        <MeasureRow key={measure.id} measure={measure} />
      ))}
    </ul>
  );
}

function ClaimRow({ claim, name, used }: { claim: EvidenceClaim; name: string; used: boolean }) {
  const unreviewed = claim.author === 'llm' && !claim.reviewed;
  return (
    <li className={styles.evidenceItem}>
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
        Open in your research →
      </Link>
    </li>
  );
}

function MeasureRow({ measure }: { measure: EvidenceMeasure }) {
  return (
    <li className={styles.evidenceItem}>
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
