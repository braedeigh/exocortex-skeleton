/**
 * OrganicVerdict.tsx — buy organic or not, on each grocery-list row.
 *
 * What this file does: fetches, for every item on the list, the research
 * verdict (numbers-backed, from the research tables) and Claude's estimate
 * (from general knowledge), and draws them. GroceryListCard.tsx puts an
 * OrganicChip on every food row; tapping it opens OrganicModal: the verdict, a
 * summary of why, where the food comes from (ComesFrom.tsx, from the map
 * sources linked to its food — or, when none are, a "Request linking" button
 * that queues it for research, ecosystem/RequestLinkButton.tsx), and one
 * button into the food's own page in the Food area (/food/foods/<name>, drawn
 * by features/research/FoodPage.tsx), which holds the claims, studies,
 * contaminants and her review. The EstimateBar above the list starts an
 * estimate run for items with none.
 *
 * A research verdict is drawn solid; an estimate is drawn dashed with "≈" in
 * front, so a guess never looks like research. Server: routes/food.py
 * (list-verdicts, estimates/run) → estimatestore.py.
 *
 * Prompt that produced this file: "I want every food item to have a summary up
 * at the top and then just a button to click into the claims, no claims on
 * the button. Then I want for every food item to have its own page on the
 * research section that the popup ports into."
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ecoSourcesForFood } from '../ecosystem/ecoMatch';
import { RequestLinkButton } from '../ecosystem/RequestLinkButton';
import { getListVerdicts, runEstimates } from './api';
import { ComesFrom } from './ComesFrom';
import { Modal } from './Modal';
import { isLinkRequested } from './requestState';
import type { EcoRequested, EcoSource, ListVerdictItem, ListVerdicts, OrganicVerdict, VerdictReview } from './types';
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
 * estimate, else a quiet "organic?". Tapping opens the popup. */
export function OrganicChip({ item, onOpen }: { item: ListVerdictItem | undefined; onOpen: () => void }) {
  if (!item || item.kind !== 'food') return null;
  const shown = item.research ?? item.estimate;
  // Nothing decided yet: a quiet chip all the same, so every food on the
  // list has a popup and a way into its page.
  if (!shown) {
    return (
      <button type="button" className={`${styles.chip} ${styles.verdictOpen} ${styles.chipGuess}`} title="Nothing decided yet — tap for its page" onClick={onOpen}>
        organic?
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

/** The popup: one verdict, one summary of why, where the food comes from,
 * and one button into the food's own page in the Food area, where the claims,
 * studies, contaminants and her review live. The research verdict's reasoning
 * is the summary when there is one; otherwise Claude's estimate's. */
export function OrganicModal({
  item,
  data,
  sources,
  requested,
  onRequested,
  onClose,
}: {
  item: ListVerdictItem;
  data: ListVerdicts;
  /** Every map source, with its links; the ones linked to this item's food are shown. */
  sources: EcoSource[];
  /** Foods already queued for research, so the button reads "Requested". */
  requested?: EcoRequested;
  /** A request went through — refetch so eco_requested catches up. */
  onRequested?: () => void;
  onClose: () => void;
}) {
  const [requestError, setRequestError] = useState('');
  const words = data.vocab.verdicts;
  const { research, estimate } = item;
  const summary = research?.reasoning || estimate?.summary;

  return (
    <Modal title={item.name} onClose={onClose}>
      <div className={styles.section}>
        {research ? (
          <>
            <div className={`${styles.verdictLine} ${VERDICT_CLASS[research.verdict]}`}>{words[research.verdict]}</div>
            <div className={styles.meta}>from your research · {REVIEW_WORDS[research.review]}</div>
          </>
        ) : estimate ? (
          <>
            <div className={`${styles.verdictLine} ${VERDICT_CLASS[estimate.verdict]}`}>≈ {words[estimate.verdict]}</div>
            <div className={styles.meta}>
              Claude’s guess · {estimate.confidence} confidence · {REVIEW_WORDS[estimate.review]}
            </div>
          </>
        ) : (
          <div className={styles.meta}>Not estimated yet — use “Estimate” above the list.</div>
        )}
        {summary ? <p className={styles.summary}>{summary}</p> : null}
        {/* Where it comes from: its linked sources, or a button that queues it for research.
            A food not in the catalog yet has no sources, so it's requested by name. */}
        <div className={styles.comesFrom}>
          <ComesFrom
            sources={item.food_id != null ? ecoSourcesForFood(item.food_id, sources) : []}
            untraced={
              <RequestLinkButton
                foodId={item.food_id ?? null}
                foodName={item.name}
                requested={isLinkRequested(requested, item.food_id, item.name)}
                from="grocery"
                onRequested={onRequested}
                onError={setRequestError}
              />
            }
          />
          {requestError ? <div className={styles.meta}>Couldn’t request: {requestError}</div> : null}
        </div>
        <Link to="/food/foods/$name" params={{ name: item.name }} className={styles.pageBtn}>
          Read the research →
        </Link>
      </div>
    </Modal>
  );
}
