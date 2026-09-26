/**
 * TableDetail.tsx — one opened cell of a research table, beside the grid on
 * TablesPage.tsx. Where her review happens.
 *
 * A measures cell lists every number in it as a card: the number (and the
 * figure as the source printed it, when it was converted), the study it came
 * from with the exact passage, the stand-in food when there was one, the
 * ground it stands on, the verdicts resting on it, and its earlier versions.
 * A verdict cell lists the verdicts the same way, with the numbers under each
 * — and a form for her own verdict, which is born confirmed and keeps the
 * agent's in the history.
 *
 * Each card fetches its own detail (useMeasure / useJudgment in
 * useTablesData.ts); a review click refreshes the grid as well, so the cell's
 * colour follows. Server: routes/research_tables.py.
 */

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { formatAmount, MEASURE_WORDS } from './tableMath';
import { REVIEW_CLASS } from './tableStyles';
import type { JudgmentDetail, MeasureDetail, Review, TableView, TablesVocab, VerdictKey } from './types';
import { useJudgment, useMeasure, type useTablesMutations } from './useTablesData';
import pageStyles from './ResearchPage.module.css';
import claimStyles from './ClaimsPage.module.css';
import styles from './TablesPage.module.css';

type Mutations = ReturnType<typeof useTablesMutations>;

export function TableDetail({
  view,
  vocab,
  foodId,
  columnId,
  mutations,
  onClose,
}: {
  view: TableView;
  vocab: TablesVocab | undefined;
  foodId: number;
  columnId: string;
  mutations: Mutations;
  onClose: () => void;
}) {
  const row = view.rows.find((candidate) => candidate.food_id === foodId);
  const column = view.columns.find((candidate) => candidate.id === columnId);
  const entries = row?.cells[columnId] ?? [];
  const judgments = view.table.kind === 'judgments';

  return (
    <div className={claimStyles.claimCard}>
      <div className={claimStyles.sourcePaneHead}>
        <div className={claimStyles.sourcePaneTitle}>
          {row?.food ?? 'this food'} × {column?.name ?? columnId}
        </div>
        <button type="button" className={claimStyles.closeBtn} title="Close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>

      {entries.length === 0 && !judgments ? (
        <div className={claimStyles.emptyNote}>
          No numbers here yet. A research agent filling this table lists it as a gap (<code>show-table --gaps</code>).
        </div>
      ) : null}

      {judgments
        ? entries.map((entry) => <JudgmentCard key={entry.id} id={entry.id} vocab={vocab} mutations={mutations} />)
        : entries.map((entry) => <MeasureCard key={entry.id} id={entry.id} mutations={mutations} />)}

      {judgments && vocab ? (
        <OwnVerdict
          key={`${foodId}-${columnId}`}
          lens={columnId}
          vocab={vocab}
          saving={mutations.setJudgment.isPending}
          onSave={(verdict, reasoning) => mutations.setJudgment.mutate({ food: foodId, lens: columnId, verdict, reasoning })}
        />
      ) : null}
    </div>
  );
}

/** The three review buttons. The one in force is filled; tapping it again
 * does nothing, tapping another changes it. */
function ReviewButtons({ review, onReview, busy }: { review: Review; onReview: (review: Review) => void; busy: boolean }) {
  const options: { value: Review; label: string; on: string }[] = [
    { value: 'confirmed', label: '✓ confirm', on: pageStyles.chipVerified },
    { value: 'disputed', label: '✗ dispute', on: pageStyles.chipShaky },
    { value: 'unreviewed', label: '↺ not reviewed', on: pageStyles.chipInteresting },
  ];
  return (
    <div className={styles.reviewRow}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={busy}
          className={`${styles.reviewBtn} ${review === option.value ? option.on : ''}`}
          aria-pressed={review === option.value}
          onClick={() => review !== option.value && onReview(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Who wrote it, as a chip. */
function AuthorChip({ author }: { author: 'llm' | 'owner' }) {
  return (
    <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>{author === 'llm' ? '✨ agent' : 'you'}</span>
  );
}

/** Earlier versions, folded away. Shows what each said and who replaced it. */
function History({ history, describe }: { history: MeasureDetail['history']; describe: (snapshot: Record<string, unknown>) => string }) {
  if (!history.length) return null;
  return (
    <details className={styles.history}>
      <summary>
        {history.length} earlier {history.length === 1 ? 'version' : 'versions'}
      </summary>
      {history.map((entry, index) => (
        <div key={index} className={styles.historyLine}>
          <span>{describe(entry.snapshot)}</span>
          <span className={styles.historyWhen}>
            {entry.replaced_by === 'deleted' ? 'deleted' : `changed by ${entry.replaced_by === 'owner' ? 'you' : 'an agent'}`}{' '}
            {entry.replaced_at.slice(0, 10)}
          </span>
        </div>
      ))}
    </details>
  );
}

/** One number in full, with her review of it. */
function MeasureCard({ id, mutations }: { id: number; mutations: Mutations }) {
  const query = useMeasure(id);
  const measure = query.data;
  if (query.isLoading) return <div className={pageStyles.loading}>Loading&hellip;</div>;
  if (!measure) return <div className={claimStyles.errorNote}>Could not load this number.</div>;

  const details = [measure.hazard, measure.basis, measure.year ? String(measure.year) : '', measure.sample_size ? `n=${measure.sample_size}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`${styles.entryCard} ${REVIEW_CLASS[measure.review]}`}>
      <div className={styles.entryHead}>
        <span className={claimStyles.valueAmount}>{formatAmount(measure.amount, measure.unit)}</span>
        <span className={styles.entryWords}>{MEASURE_WORDS[measure.measure]}</span>
      </div>
      <div className={claimStyles.valueLine}>{details}</div>
      {measure.as_reported ? <div className={claimStyles.valueLine}>printed as {measure.as_reported}</div> : null}
      {measure.measured_on ? (
        <div className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipOrange}`}>
          ≈ measured on {measure.measured_on} — a stand-in, not {measure.food} itself
        </div>
      ) : null}

      {/* The study behind the number, and the exact words it says it in. */}
      {measure.source ? (
        <div className={styles.sourceBlock}>
          <div className={claimStyles.sourceText}>{measure.source.text}</div>
          {measure.source.url ? (
            <a className={pageStyles.srcLink} href={measure.source.url} target="_blank" rel="noopener noreferrer">
              {measure.source.url.length > 70 ? `${measure.source.url.slice(0, 70)}…` : measure.source.url} &#8599;
            </a>
          ) : null}
          {measure.passage?.exact ? <div className={claimStyles.sourceQuote}>&ldquo;{measure.passage.exact}&rdquo;</div> : null}
        </div>
      ) : (
        <div className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipShaky}`}>no source on this number</div>
      )}

      <div className={pageStyles.tagRow}>
        <AuthorChip author={measure.author} />
        {measure.tier ? <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>{measure.tier}</span> : null}
        {measure.claim ? (
          <Link to="/research/claims" search={{ claim: measure.claim.id }} className={pageStyles.chip}>
            open its claim &#8250;
          </Link>
        ) : null}
        {measure.judgments.map((judgment) => (
          <span key={judgment.id} className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>
            ⚖︎ a {judgment.lens} verdict rests on this
          </span>
        ))}
      </div>
      {measure.note ? <div className={claimStyles.sourceNote}>{measure.note}</div> : null}

      <ReviewButtons
        review={measure.review}
        busy={mutations.reviewMeasure.isPending}
        onReview={(review) => mutations.reviewMeasure.mutate({ id, review })}
      />
      <History
        history={measure.history}
        describe={(old) => `${formatAmount(Number(old.amount), String(old.unit))}${old.year ? ` (${String(old.year)})` : ''} — was ${String(old.review)}`}
      />
    </div>
  );
}

/** One verdict in full: what, why, the numbers under it, and her review. */
/** One verdict in full, with its review buttons. Also opened on its own by
 * TablesPage when linked to with ?verdict=<id> (the kitchen's grocery list
 * links here). */
export function JudgmentCard({ id, vocab, mutations }: { id: number; vocab: TablesVocab | undefined; mutations: Mutations }) {
  const query = useJudgment(id);
  const judgment: JudgmentDetail | undefined = query.data;
  if (query.isLoading) return <div className={pageStyles.loading}>Loading&hellip;</div>;
  if (!judgment) return <div className={claimStyles.errorNote}>Could not load this verdict.</div>;

  return (
    <div className={`${styles.entryCard} ${REVIEW_CLASS[judgment.review]}`}>
      <div className={styles.entryHead}>
        <span className={claimStyles.valueAmount}>{vocab?.verdicts[judgment.verdict] ?? judgment.verdict}</span>
        <span className={styles.entryWords}>{judgment.hazard ? `for ${judgment.hazard} only` : `${judgment.lens}, whole food`}</span>
      </div>
      {judgment.shaken ? (
        <div className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipShaky}`}>
          ⚠︎ shaken — a number it rests on is disputed
        </div>
      ) : null}
      {judgment.reasoning ? <div className={claimStyles.claimText}>{judgment.reasoning}</div> : null}

      {judgment.grounds.length ? (
        <>
          <div className={claimStyles.sourcesHead}>rests on</div>
          {judgment.grounds.map((ground) => (
            <div key={ground.id} className={`${styles.groundLine} ${REVIEW_CLASS[ground.review]}`}>
              <span>{ground.hazard}</span>
              <span className={styles.groundAmount}>
                {ground.measured_on ? '≈' : ''}
                {formatAmount(ground.amount, ground.unit)}
              </span>
              <span className={styles.historyWhen}>{ground.review}</span>
            </div>
          ))}
        </>
      ) : (
        <div className={claimStyles.valueLine}>No numbers named under this verdict.</div>
      )}

      <div className={pageStyles.tagRow}>
        <AuthorChip author={judgment.author} />
        {judgment.tier ? <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>{judgment.tier}</span> : null}
      </div>
      <ReviewButtons
        review={judgment.review}
        busy={mutations.reviewJudgment.isPending}
        onReview={(review) => mutations.reviewJudgment.mutate({ id, review })}
      />
      <History
        history={judgment.history}
        describe={(old) => `${vocab?.verdicts[old.verdict as VerdictKey] ?? String(old.verdict)} — by ${old.author === 'owner' ? 'you' : 'an agent'}`}
      />
    </div>
  );
}

/** Her own verdict on the whole food through this lens. Saving it makes it
 * hers and confirmed; an agent's verdict it replaces stays in the history. */
function OwnVerdict({
  lens,
  vocab,
  saving,
  onSave,
}: {
  lens: string;
  vocab: TablesVocab;
  saving: boolean;
  onSave: (verdict: VerdictKey, reasoning: string) => void;
}) {
  const [verdict, setVerdict] = useState<VerdictKey | null>(null);
  const [reasoning, setReasoning] = useState('');
  return (
    <div className={styles.ownVerdict}>
      <div className={claimStyles.sourcesHead}>your verdict ({lens})</div>
      <div className={claimStyles.pillRow}>
        {(Object.keys(vocab.verdicts) as VerdictKey[]).map((key) => (
          <button
            type="button"
            key={key}
            className={`${pageStyles.chip} ${verdict === key ? pageStyles.chipActive : ''}`}
            onClick={() => setVerdict(key)}
          >
            {vocab.verdicts[key]}
          </button>
        ))}
      </div>
      <textarea
        className={`${pageStyles.input} ${styles.reasoning}`}
        placeholder="why (optional)"
        value={reasoning}
        onChange={(event) => setReasoning(event.target.value)}
      />
      <button type="button" className={pageStyles.primaryBtn} disabled={!verdict || saving} onClick={() => verdict && onSave(verdict, reasoning.trim())}>
        {saving ? 'Saving…' : 'Save my verdict'}
      </button>
    </div>
  );
}
