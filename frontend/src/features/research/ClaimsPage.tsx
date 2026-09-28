/**
 * ClaimsPage.tsx — the claims table at /research/claims: every claim the
 * research sessions (or the owner) have written, with the annotated source
 * beside each one.
 *
 * Two columns. Left: the table — one row per claim, newest first, filterable
 * by front and topic (pills), stepped with prev/next buttons or the arrow
 * keys. Right: the selected claim in full — verdict, measured value, then its
 * sources as rows. Tapping a source opens a pane BELOW the source list (not a
 * modal — she wants it beside the claim) showing the source's extracted text
 * with the linked passage active and scrolled into view — in the source's own
 * PDF when the commons holds one (features/exposure/PdfPassage.tsx, the
 * passage highlighted on the page), else, or at a tap, in its extracted text
 * through AnnotatedText.tsx — and above it the other claims citing that
 * source as chips, so she can click back and forth between claims through a
 * shared source.
 *
 * Under 720px the columns stack: the table is the view until a claim is
 * picked, then the detail takes over with an "‹ all claims" bar to return.
 *
 * Data: useClaims / useClaim / useSourceClaims (useResearchData.ts, backed by
 * /api/research/claims…) plus useDocText / useAnnotations for the source
 * pane; topics, fronts and the live-session signal come from the research
 * doc via useResearch (polling every 5s while a session runs is what makes
 * the table "real time"). Search params (?claim=&topic=&front=) are the
 * page's whole selection state, typed by routes/research_.claims.tsx.
 *
 * Built on the owner's ask: "a claims table… i want to be able to view the
 * annotated source next to every claim in real time. every claim should be
 * linked to all its sources and i should be able to click between with easy
 * viewing of all the claims."
 */

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { getSourcePdfInfo } from '../exposure/api';
import { ApiError } from '../../api/client';
import { FRONT_EMOJI, type Front } from '../fronts/useFronts';
import { resolveSelector } from './anchor';
import { AnnotatedText } from './AnnotatedText';
import { researchErrorMessage } from './api';
import { anySessionInFlight, plural, topicsById, truncate } from './helpers';
import type { Annotation, Claim, ClaimSource, ClaimSourceAnnotation, ClaimValue, Topic } from './types';
import {
  CLAIMS_POLL_MS,
  useAnnotations,
  useClaim,
  useClaims,
  useDocText,
  useFronts,
  useResearch,
  useSourceClaims,
} from './useResearchData';
import pageStyles from './ResearchPage.module.css';
import styles from './ClaimsPage.module.css';

// The PDF viewer (and pdf.js with it) loads only when a source's PDF opens.
const PdfPassage = lazy(() => import('../exposure/PdfPassage').then((module) => ({ default: module.PdfPassage })));

/** The page's selection state, carried in the URL so a claim can be linked
 * to from a thread row ("⇢ sources") and shared as an address. */
export interface ClaimsSearch {
  claim?: string;
  topic?: string;
  front?: string;
}

// The router knows this page two ways: by route id (what useSearch wants)
// and by path (what useNavigate wants).
const ROUTE_ID = '/research_/claims' as const;
const ROUTE_PATH = '/research/claims' as const;

/** Verdict → chip colour, the same mapping as a claim row in a thread. */
function verdictClass(verdict: string): string {
  if (verdict === 'real') return pageStyles.chipVerified;
  if (verdict === 'shaky') return pageStyles.chipShaky;
  if (verdict === 'interesting') return pageStyles.chipInteresting;
  return '';
}

/** Stance → chip colour: supports green, contradicts red, context plain. */
function stanceClass(stance: string): string {
  if (stance === 'supports') return pageStyles.chipVerified;
  if (stance === 'contradicts') return pageStyles.chipShaky;
  return pageStyles.chipStatic;
}

/** "12,000 mg" — the value's number and unit, or '' when there is no number. */
function formatAmount(value: ClaimValue | null): string {
  if (!value || value.amount === null || value.amount === undefined) return '';
  const amount = Number.isFinite(value.amount) ? value.amount.toLocaleString() : String(value.amount);
  return value.unit ? `${amount} ${value.unit}` : amount;
}

/** Newest first, by the created stamp. */
function newestFirst(claims: Claim[]): Claim[] {
  return claims.slice().sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

/** The annotations to draw over a source's text.
 * The doc's own list, plus the linked passage if the list doesn't already
 * carry it (the link may point at a passage the annotations store hasn't
 * returned), resolved against the live text so a drifted quote still lands. */
export function sourcePaneAnnotations(
  text: string,
  fetched: Annotation[],
  linked: ClaimSourceAnnotation | null,
): Annotation[] {
  if (!linked || fetched.some((annotation) => annotation.id === linked.id)) return fetched;
  const resolved = resolveSelector(text, {
    exact: linked.exact,
    char_start: linked.char_start,
    char_end: linked.char_end,
  });
  return [
    ...fetched,
    {
      id: linked.id,
      doc: linked.doc,
      content: { kind: 'highlight', note: linked.note, source: 'llm' },
      needs_review: false,
      selector: resolved.selector,
      state: resolved.state,
    },
  ];
}

export function ClaimsPage() {
  const search = useSearch({ from: ROUTE_ID }) as ClaimsSearch;
  const navigate = useNavigate({ from: ROUTE_PATH });

  const researchQuery = useResearch();
  const frontsQuery = useFronts();
  const state = researchQuery.data ?? { topics: [], entries: [], sessions: [] };
  const byId = useMemo(() => topicsById(state.topics), [state.topics]);
  const fronts: Front[] = useMemo(() => frontsQuery.data ?? [], [frontsQuery.data]);

  // "Real time": poll everything on the page while a research session runs.
  const live = anySessionInFlight(state.sessions);

  const claimId = search.claim ?? null;
  const topicFilter = search.topic ?? '';
  const frontFilter = search.front ?? '';

  const claimsQuery = useClaims({ topic: topicFilter || undefined, front: frontFilter || undefined }, live);
  const claims = useMemo(() => newestFirst(claimsQuery.data ?? []), [claimsQuery.data]);
  const claimQuery = useClaim(claimId, live);

  // Which source is open in the pane beneath the claim, and which highlight
  // in it is active. Set together so a fresh source starts on its passage.
  const [openSource, setOpenSource] = useState<{ id: string; doc: string; activeId: string | null } | null>(null);

  // Rewrite the URL's selection — the only state the page keeps.
  function go(patch: Partial<ClaimsSearch>) {
    void navigate({
      search: (previous) => {
        const next: ClaimsSearch = { ...previous, ...patch };
        if (!next.claim) delete next.claim;
        if (!next.topic) delete next.topic;
        if (!next.front) delete next.front;
        return next;
      },
    });
  }

  // Step to the previous / next claim in the table's order.
  const selectedIndex = claims.findIndex((claim) => claim.id === claimId);
  function step(delta: 1 | -1) {
    if (!claims.length) return;
    const next =
      selectedIndex === -1 ? (delta === 1 ? 0 : claims.length - 1) : (selectedIndex + delta + claims.length) % claims.length;
    go({ claim: claims[next].id });
  }

  // Arrow keys step the claim too, unless she's typing somewhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims, selectedIndex]);

  // The filter pills come from the research doc: fronts any topic is tagged
  // with, and the topics on the chosen front.
  const frontIds = useMemo(() => {
    const seen = new Set<string>();
    for (const topic of state.topics) for (const frontId of topic.fronts ?? []) seen.add(frontId);
    return fronts.filter((front) => seen.has(front.id)).map((front) => front.id);
  }, [state.topics, fronts]);
  const topicChoices: Topic[] = useMemo(
    () =>
      state.topics
        .filter((topic) => !frontFilter || (topic.fronts ?? []).includes(frontFilter))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [state.topics, frontFilter],
  );

  const selected = claimQuery.data;
  const claimsError = claimsQuery.isError
    ? researchErrorMessage(claimsQuery.error, 'Could not load the claims.', 'Claims')
    : null;

  return (
    <div className={`${pageStyles.page} ${styles.page}`}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Claims</h1>
        <span className={pageStyles.pageSub}>every claim beside its sources</span>
        {live ? <span className={styles.livePill}>live</span> : null}
        {/* The Research tab lands here; the thread directory is the other
            half of the page, one tap away — the same pill it uses to reach
            this table, pointing back. */}
        <Link to="/research" search={{}} className={pageStyles.pageHeadLink} title="Research threads">
          &#9776; Threads
        </Link>
        {/* The research tables — the numbers inside these claims, as a grid. */}
        <Link to="/research/tables" search={{}} className={`${pageStyles.pageHeadLink} ${styles.nextHeadLink}`} title="Research tables">
          &#9638; Tables
        </Link>
        {/* A page per food — buy organic or not, with its claims and studies. */}
        <Link to="/research/foods" className={`${pageStyles.pageHeadLink} ${styles.nextHeadLink}`} title="Every food">
          Foods
        </Link>
      </div>

      {/* Filter pills: one row of fronts, one row of that front's topics. */}
      <div className={styles.filters}>
        <div className={styles.pillRow}>
          <button
            type="button"
            className={`${pageStyles.chip} ${!frontFilter ? pageStyles.chipActive : ''}`}
            onClick={() => go({ front: undefined, topic: undefined })}
          >
            all fronts
          </button>
          {frontIds.map((frontId) => {
            const front = fronts.find((candidate) => candidate.id === frontId);
            return (
              <button
                type="button"
                key={frontId}
                className={`${pageStyles.chip} ${frontFilter === frontId ? pageStyles.chipActive : ''}`}
                onClick={() => go({ front: frontFilter === frontId ? undefined : frontId, topic: undefined })}
              >
                {FRONT_EMOJI[frontId] ?? '🏷️'} {front ? front.name : frontId}
              </button>
            );
          })}
        </div>
        {topicChoices.length ? (
          <div className={styles.pillRow}>
            <button
              type="button"
              className={`${pageStyles.chip} ${!topicFilter ? pageStyles.chipActive : ''}`}
              onClick={() => go({ topic: undefined })}
            >
              all topics
            </button>
            {topicChoices.map((topic) => (
              <button
                type="button"
                key={topic.id}
                className={`${pageStyles.chip} ${topicFilter === topic.id ? pageStyles.chipActive : ''}`}
                onClick={() => go({ topic: topicFilter === topic.id ? undefined : topic.id })}
              >
                {topic.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className={`${styles.main} ${claimId ? styles.detailOpen : ''}`}>
        {/* Left: the table. */}
        <div className={styles.table}>
          <div className={styles.tableHead}>
            <span className={styles.cellText}>Claim</span>
            <span className={styles.cellValue}>Value</span>
            <span className={styles.cellVerdict}>Verdict</span>
            <span className={styles.cellSources}>Sources</span>
          </div>
          {claimsQuery.isLoading ? (
            <div className={pageStyles.loading}>Loading&hellip;</div>
          ) : claimsError ? (
            <div className={styles.errorNote}>{claimsError}</div>
          ) : claims.length === 0 ? (
            <div className={styles.emptyNote}>
              {topicFilter || frontFilter
                ? 'No claims match this filter.'
                : 'No claims yet — a research session writes them as it reads, and claims filed in a thread land here too.'}
            </div>
          ) : (
            claims.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} byId={byId} selected={claim.id === claimId} onSelect={() => go({ claim: claim.id })} />
            ))
          )}
        </div>

        {/* Right: the selected claim, its sources, and the source pane. */}
        <div className={styles.detail}>
          <button type="button" className={styles.backBar} onClick={() => go({ claim: undefined })}>
            &#8249; all claims
          </button>
          <div className={styles.stepRow}>
            <button type="button" className={pageStyles.outlineBtn} disabled={!claims.length} onClick={() => step(-1)}>
              &#8249; prev
            </button>
            <span className={styles.stepCount}>
              {selectedIndex === -1 ? `${claims.length} ${plural(claims.length, 'claim', 'claims')}` : `${selectedIndex + 1} of ${claims.length}`}
            </span>
            <button type="button" className={pageStyles.outlineBtn} disabled={!claims.length} onClick={() => step(1)}>
              next &#8250;
            </button>
          </div>

          {!claimId ? (
            <div className={styles.emptyNote}>Pick a claim to see its sources.</div>
          ) : claimQuery.isLoading ? (
            <div className={pageStyles.loading}>Loading&hellip;</div>
          ) : claimQuery.isError || !selected ? (
            <div className={styles.errorNote}>
              {claimQuery.isError
                ? researchErrorMessage(claimQuery.error, 'Could not load this claim.', 'Claims')
                : 'This claim could not be found.'}
            </div>
          ) : (
            <ClaimDetail
              claim={selected.claim}
              value={selected.value ?? selected.claim.value}
              sources={selected.sources ?? []}
              byId={byId}
              fronts={fronts}
              openSourceId={openSource?.id ?? null}
              onOpenSource={(source) =>
                setOpenSource(
                  openSource && openSource.id === source.id
                    ? null
                    : { id: source.id, doc: source.annotation?.doc || source.doc, activeId: source.annotation?.id ?? null },
                )
              }
            />
          )}

          {openSource ? (
            <SourcePane
              sourceId={openSource.id}
              doc={openSource.doc}
              linked={selected?.sources.find((source) => source.id === openSource.id)?.annotation ?? null}
              activeId={openSource.activeId}
              currentClaimId={claimId}
              live={live}
              onActivate={(id) => setOpenSource({ ...openSource, activeId: id })}
              onPickClaim={(id) => go({ claim: id })}
              onClose={() => setOpenSource(null)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One table row: text (clamped to two lines; the full text is in the detail
 * once tapped), value, verdict + tier, source count, topic chips. */
function ClaimRow({
  claim,
  byId,
  selected,
  onSelect,
}: {
  claim: Claim;
  byId: Record<string, Topic>;
  selected: boolean;
  onSelect: () => void;
}) {
  const amount = formatAmount(claim.value);
  return (
    <button type="button" className={`${styles.row} ${selected ? styles.rowSelected : ''}`} onClick={onSelect}>
      <span className={styles.cellText}>
        <span className={styles.rowText}>{claim.text}</span>
        {claim.topics.length ? (
          <span className={styles.rowTopics}>
            {claim.topics.map((topicId) => (
              <span key={topicId} className={styles.topicTag}>
                {byId[topicId]?.name ?? topicId}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className={`${styles.cellValue} ${styles.rowValue}`}>{amount || '—'}</span>
      <span className={styles.cellVerdict}>
        <span className={`${styles.smallChip} ${verdictClass(claim.verdict)}`}>{claim.verdict || 'unjudged'}</span>
        {claim.value?.tier ? <span className={styles.smallChip}>{claim.value.tier}</span> : null}
      </span>
      <span className={`${styles.cellSources} ${styles.rowSources}`}>{claim.source_count}</span>
    </button>
  );
}

/** The selected claim in full, then its sources as rows. */
function ClaimDetail({
  claim,
  value,
  sources,
  byId,
  fronts,
  openSourceId,
  onOpenSource,
}: {
  claim: Claim;
  value: ClaimValue | null;
  sources: ClaimSource[];
  byId: Record<string, Topic>;
  fronts: Front[];
  openSourceId: string | null;
  onOpenSource: (source: ClaimSource) => void;
}) {
  const amount = formatAmount(value);
  const valueLine = value
    ? [value.subject, value.measure, value.basis, value.year ? String(value.year) : ''].filter(Boolean).join(' · ')
    : '';
  return (
    <div className={styles.claimCard}>
      <div className={styles.claimHead}>
        <span className={`${pageStyles.kind} ${pageStyles.kindClaim}`}>Claim</span>
        <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${verdictClass(claim.verdict)}`}>
          {claim.verdict || 'unjudged'}
        </span>
        {claim.author === 'llm' ? (
          <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${claim.reviewed ? pageStyles.chipVerified : pageStyles.chipInteresting}`}>
            &#10024; {claim.reviewed ? 'reviewed' : 'unreviewed'}
          </span>
        ) : null}
        {claim.created ? <span className={styles.claimDate}>{claim.created.slice(0, 10)}</span> : null}
      </div>
      <div className={styles.claimText}>{claim.text}</div>

      {value && (amount || valueLine || value.tier) ? (
        <div className={styles.valueBlock}>
          {amount ? <div className={styles.valueAmount}>{amount}</div> : null}
          {valueLine ? <div className={styles.valueLine}>{valueLine}</div> : null}
          {value.tier ? <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>tier: {value.tier}</span> : null}
        </div>
      ) : null}

      {claim.topics.length || claim.fronts.length ? (
        <div className={pageStyles.tagRow}>
          {claim.fronts.map((frontId) => (
            <span key={`front-${frontId}`} className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>
              {FRONT_EMOJI[frontId] ?? '🏷️'} {fronts.find((front) => front.id === frontId)?.name ?? frontId}
            </span>
          ))}
          {claim.topics.map((topicId) => (
            <span key={`topic-${topicId}`} className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>
              {byId[topicId]?.name ?? topicId}
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.sourcesHead}>
        {sources.length} {plural(sources.length, 'source', 'sources')}
      </div>
      {sources.length === 0 ? (
        <div className={styles.emptyNote}>No sources linked to this claim yet.</div>
      ) : (
        sources.map((source) => {
          const open = source.id === openSourceId;
          const canOpen = !!source.annotation || source.has_text;
          return (
            <div key={source.id} className={`${styles.sourceRow} ${open ? styles.sourceRowOpen : ''}`}>
              <div className={styles.sourceMain}>
                <div className={styles.sourceText}>{truncate(source.text || source.url || source.id, 200)}</div>
                {source.url ? (
                  <a className={pageStyles.srcLink} href={source.url} target="_blank" rel="noopener noreferrer">
                    {truncate(source.url, 80)} &#8599;
                  </a>
                ) : null}
                {source.note ? <div className={styles.sourceNote}>{source.note}</div> : null}
                {source.annotation?.exact ? (
                  <div className={styles.sourceQuote}>&ldquo;{truncate(source.annotation.exact, 160)}&rdquo;</div>
                ) : null}
              </div>
              <div className={styles.sourceChips}>
                <span className={`${pageStyles.chip} ${stanceClass(source.stance)}`}>{source.stance}</span>
                {source.verdict === 'verified' ? (
                  <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipVerified}`}>&#10003; verified</span>
                ) : null}
                {canOpen ? (
                  <button
                    type="button"
                    className={`${pageStyles.chip} ${open ? pageStyles.chipActive : ''}`}
                    onClick={() => onOpenSource(source)}
                  >
                    {open ? '× close' : source.annotation ? '📖 open passage' : '📖 open text'}
                  </button>
                ) : (
                  <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`} title="No text fetched for this source yet">
                    no text
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/** The pane beneath the sources: the claims citing this source as chips
 * (tap one to jump), then the source's text with the linked passage active. */
function SourcePane({
  sourceId,
  doc,
  linked,
  activeId,
  currentClaimId,
  live,
  onActivate,
  onPickClaim,
  onClose,
}: {
  sourceId: string;
  doc: string;
  linked: ClaimSourceAnnotation | null;
  activeId: string | null;
  currentClaimId: string | null;
  live: boolean;
  onActivate: (id: string) => void;
  onPickClaim: (id: string) => void;
  onClose: () => void;
}) {
  const citingQuery = useSourceClaims(sourceId, live);
  const textQuery = useDocText(doc);
  const annotationsQuery = useAnnotations(doc, live ? CLAIMS_POLL_MS : false);

  const text = textQuery.data?.text ?? '';
  const annotations = useMemo(
    () => sourcePaneAnnotations(text, annotationsQuery.data ?? [], linked),
    [text, annotationsQuery.data, linked],
  );
  const citing = citingQuery.data?.claims ?? [];
  const title = textQuery.data?.title || citingQuery.data?.source.text || doc;

  // The source's own PDF, when the commons holds one: shown first, with the
  // extracted text a tap away.
  const pdfQuery = useQuery({
    queryKey: ['exposure', 'source-pdf', sourceId],
    queryFn: ({ signal }) => getSourcePdfInfo(sourceId, signal),
    staleTime: 60_000,
  });
  const [preferText, setPreferText] = useState(false);
  const hasPdf = !!pdfQuery.data?.pdf;
  const showPdf = hasPdf && !preferText;
  const activePassage = annotations.find((annotation) => annotation.id === activeId) ?? null;
  const activePage = activeId ? (pdfQuery.data?.passages?.[activeId] ?? null) : null;

  const textError = textQuery.error;
  const textErrorMessage = textError
    ? textError instanceof ApiError && textError.status === 404
      ? 'No text fetched for this source yet.'
      : researchErrorMessage(textError, 'Could not load the source text.')
    : null;

  return (
    <div className={styles.sourcePane}>
      <div className={styles.sourcePaneHead}>
        <div className={styles.sourcePaneTitle}>{truncate(title, 90)}</div>
        <button type="button" className={styles.closeBtn} title="Close source" aria-label="Close source" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className={styles.citingHead}>Claims citing this source</div>
      <div className={styles.pillRow}>
        {citingQuery.isLoading ? (
          <span className={styles.emptyNote}>Loading&hellip;</span>
        ) : citing.length === 0 ? (
          <span className={styles.emptyNote}>Only this one.</span>
        ) : (
          newestFirst(citing).map((claim) => (
            <button
              type="button"
              key={claim.id}
              className={`${pageStyles.chip} ${claim.id === currentClaimId ? pageStyles.chipActive : ''}`}
              title={claim.text}
              onClick={() => onPickClaim(claim.id)}
            >
              {truncate(claim.text, 60)}
            </button>
          ))
        )}
      </div>

      {hasPdf ? (
        <div className={styles.pillRow} role="group" aria-label="How to show the source">
          <button
            type="button"
            className={`${pageStyles.chip} ${showPdf ? pageStyles.chipActive : ''}`}
            onClick={() => setPreferText(false)}
          >
            📄 PDF
          </button>
          <button
            type="button"
            className={`${pageStyles.chip} ${!showPdf ? pageStyles.chipActive : ''}`}
            onClick={() => setPreferText(true)}
          >
            ¶ Text
          </button>
        </div>
      ) : null}

      {showPdf ? (
        <Suspense fallback={<span className={styles.emptyNote}>Opening the PDF&hellip;</span>}>
          <PdfPassage
            sourceId={sourceId}
            page={activePage}
            passage={activePassage?.selector?.exact ?? linked?.exact ?? null}
            pageCount={pdfQuery.data?.pages ?? null}
          />
        </Suspense>
      ) : textErrorMessage ? (
        <div className={styles.errorNote}>{textErrorMessage}</div>
      ) : (
        <AnnotatedText
          className={styles.sourceDoc}
          text={text}
          annotations={annotations}
          activeId={activeId}
          loading={textQuery.isLoading}
          onMarkClick={onActivate}
        />
      )}
    </div>
  );
}
