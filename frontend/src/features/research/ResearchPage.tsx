/**
 * ResearchPage.tsx — native port of the standalone /research place
 * (templates/research.html + static/js/research.js). A flat pool of learning
 * notes; topics are threads over the pool, not boxes. Two views:
 *
 *   /research              — the main directory: capture composer + the
 *                            threads list only (phase ① of a redesign —
 *                            search/questions/unfiled/articles/library cards
 *                            are gone; topic creation lives in the composer's
 *                            front picker, and unfiled entries surface as the
 *                            Uncategorized pseudo-thread, UNFILED_ID)
 *   /research?thread=<id>  — one thread's chat view (was '#thread/<id>');
 *                            thread=UNFILED_ID is the synthetic Uncategorized
 *                            thread over topicless entries
 *
 * She flags entries to queue them for Claude; a send fires a research-runner
 * session that writes reply entries back into the thread, and the research
 * query polls every 5s while any session is running/queued so replies land
 * without a manual refresh.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import type { AddEntryBody } from './api';
import { Annotator } from './Annotator';
import { Composer, COMPOSER_TEXT_ID } from './Composer';
import { anySessionInFlight, contextChain, landingLabel, plural, topicsById } from './helpers';
import { HealthPill } from './HealthPill';
import { Reader } from './Reader';
import { ResearchProvider, type ResearchCtxValue } from './ResearchContext';
import { ThreadsDirectoryCard } from './ThreadsDirectory';
import { ThreadView } from './ThreadView';
import { emptyComposer, UNFILED_ID, type ComposerState, type Entry, type Topic } from './types';
import { useDocTexts, useFronts, useLibrary, useResearch, useResearchMutations } from './useResearchData';
import styles from './ResearchPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

export function ResearchPage() {
  const isPublic = isPublicMode();

  const search = useSearch({ from: '/research' }) as { thread?: string };
  const navigate = useNavigate({ from: '/research' });

  const { toasts, push, dismiss } = useToasts();

  const researchQuery = useResearch();
  const libraryQuery = useLibrary();
  const docTextsQuery = useDocTexts();
  const frontsQuery = useFronts();
  const mutations = useResearchMutations(push);

  const state = researchQuery.data ?? { topics: [], entries: [], sessions: [] };
  const byId = useMemo(() => topicsById(state.topics), [state.topics]);
  const fronts = frontsQuery.data ?? [];
  const docTexts = useMemo(() => new Set(docTextsQuery.data ?? []), [docTextsQuery.data]);
  const library = libraryQuery.data?.files ?? [];
  const edge = libraryQuery.data?.edge ?? [];

  // --- composer (one per view; the annotator can aim it) ---
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);

  // --- fronts filter (Threads card pills) ---
  const [frontFilter, setFrontFilter] = useState('all');

  // --- busy sets for per-entry fetches (the old _rsrchAnnotating/_rsrchFetchingText) ---
  const [fetchingText, setFetchingText] = useState<Set<string>>(new Set());
  const [annotatingMeta, setAnnotatingMeta] = useState<Set<string>>(new Set());

  // --- two-step confirm (ported-app convention, replaces the old modal) ---
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  function requestConfirm(key: string): boolean {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmKey === key) {
      setConfirmKey(null);
      return true;
    }
    setConfirmKey(key);
    confirmTimer.current = setTimeout(() => setConfirmKey(null), 3000);
    return false;
  }

  // --- overlays ---
  const [readerPath, setReaderPath] = useState<string | null>(null);
  const [annotator, setAnnotator] = useState<{ doc: string; title: string } | null>(null);

  // --- routing: ?thread=<id> (was location.hash '#thread/<id>') ---
  const threadId = search.thread ?? null;
  const topic: Topic | null =
    threadId === UNFILED_ID
      ? { id: UNFILED_ID, name: 'Uncategorized', status: 'active' }
      : threadId
        ? (byId[threadId] ?? null)
        : null;

  // Unknown thread id — bounce home once the data is in (old: location.hash
  // = ''). The Uncategorized pseudo-thread is exempt: it's never in byId.
  useEffect(() => {
    if (threadId && threadId !== UNFILED_ID && researchQuery.data && !byId[threadId]) {
      void navigate({ search: {}, replace: true });
    }
  }, [threadId, researchQuery.data, byId, navigate]);

  function openThread(id: string) {
    void navigate({ search: id ? { thread: id } : {} });
  }

  // --- composer flows ---

  function focusComposer() {
    setTimeout(() => {
      const ta = document.getElementById(COMPOSER_TEXT_ID);
      if (ta) {
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (ta as HTMLTextAreaElement).focus();
      }
    }, 0);
  }

  function buildPayload(st: ComposerState, extraTopicId?: string): AddEntryBody | null {
    const text = st.text.trim();
    if (!text) {
      push('Write something first.');
      return null;
    }
    const topics = new Set(st.topics);
    if (extraTopicId) topics.add(extraTopicId);
    const payload: AddEntryBody = { text, kind: st.kind, topics: Array.from(topics) };
    if (st.kind === 'source') payload.url = st.url || '';
    if (st.replyTo) payload.reply_to = st.replyTo.id;
    if (st.reQuote) payload.re_quote = st.reQuote;
    if (st.contextChain) {
      const ctx = st.contextChain.filter((c) => c.checked).map((c) => c.id);
      if (ctx.length) payload.context_ids = ctx;
    }
    return payload;
  }

  async function addEntry(extraTopicId?: string) {
    const st = composer;
    const payload = buildPayload(st, extraTopicId);
    if (!payload) return;
    let blob;
    try {
      blob = await mutations.addEntry.mutateAsync(payload);
    } catch {
      return; // mutation onError already toasted
    }
    // Answering a question auto-closes it — the reply IS the resolution.
    if (st.replyTo) {
      const q = state.entries.find((e) => e.id === st.replyTo!.id);
      if (q && q.kind === 'question' && q.status === 'open') {
        try {
          await mutations.editEntry.mutateAsync({ id: q.id, status: 'answered' });
        } catch {
          // toasted by the mutation
        }
      }
    }
    setComposer(emptyComposer());
    const newId = blob.id;
    if (newId) {
      push(`Caught — ${landingLabel(payload.topics ?? [], byId, fronts)}`, {
        tone: 'info',
        duration: 6000,
        actionLabel: 'Undo',
        onAction: () => mutations.removeEntry.mutate(newId),
        onMessageTap: () => {
          if (payload.topics && payload.topics.length) {
            openThread(payload.topics[0]);
          } else {
            openThread(UNFILED_ID);
          }
        },
      });
    }
  }

  /** Add the follow-up question and immediately fire deep research on it. */
  async function addAndResearch(extraTopicId?: string) {
    const payload = buildPayload(composer, extraTopicId);
    if (!payload) return;
    let blob;
    try {
      blob = await mutations.addEntry.mutateAsync(payload);
    } catch {
      return;
    }
    const newId = blob.id;
    if (!newId) {
      push('Entry created but id missing — cannot fire deep research.');
      setComposer(emptyComposer());
      return;
    }
    try {
      await mutations.deepResearch.mutateAsync(newId);
    } catch {
      return;
    }
    setComposer(emptyComposer());
    push('Deep research started — the report will land under the question.', { tone: 'info' });
  }

  /** Aim the composer at a question (or an llm reply): the answer inherits
   * its topics so it lands in the same lens. */
  function startAnswer(id: string) {
    const q = state.entries.find((e) => e.id === id);
    if (!q) return;
    setComposer((c) => ({
      ...c,
      replyTo: { id: q.id, text: q.text },
      kind: 'note',
      topics: new Set(q.topics ?? []),
    }));
    focusComposer();
  }

  /** Annotator "follow up": question aimed at the owning entry, carrying the
   * highlighted exact text and the full (trimmable) reply-chain context. */
  function startFollowUp(noteId: string, exact: string) {
    const note = state.entries.find((e) => e.id === noteId);
    if (!note) return;
    setAnnotator(null);
    setComposer((c) => ({
      ...c,
      kind: 'question',
      replyTo: { id: noteId, text: note.text.slice(0, 80) },
      topics: new Set(note.topics ?? []),
      reQuote: exact || null,
      contextChain: contextChain(state.entries, noteId),
    }));
    focusComposer();
  }

  // --- deletes: two-step confirm + undo toast ---

  async function restoreEntry(e: Entry) {
    const payload: AddEntryBody = {
      text: e.text,
      kind: e.kind,
      topics: e.topics ?? [],
    };
    if (e.url) payload.url = e.url;
    if (e.reply_to) payload.reply_to = e.reply_to;
    if (e.re_quote) payload.re_quote = e.re_quote;
    if (e.context_ids) payload.context_ids = e.context_ids;
    let blob;
    try {
      blob = await mutations.addEntry.mutateAsync(payload);
    } catch {
      return;
    }
    // Best effort: verdict / answered-status survive the round trip.
    const patch: { verdict?: string; status?: string } = {};
    if (e.verdict) patch.verdict = e.verdict;
    if (e.kind === 'question' && e.status === 'answered') patch.status = 'answered';
    if (blob.id && Object.keys(patch).length) {
      try {
        await mutations.editEntry.mutateAsync({ id: blob.id, ...patch });
      } catch {
        // toasted by the mutation
      }
    }
  }

  function deleteEntry(e: Entry) {
    mutations.removeEntry.mutate(e.id);
    if (e.author === 'llm') {
      // llm authorship/review state can't be recreated through the API.
      push('Entry deleted', { tone: 'info' });
    } else {
      push('Entry deleted', { tone: 'info', actionLabel: 'Undo', onAction: () => void restoreEntry(e) });
    }
  }

  function deleteTopic(t: Topic) {
    mutations.removeTopic.mutate(t.id, {
      onSuccess: () => {
        // Deleting the thread we're viewing bounces to the directory.
        if (threadId === t.id) void navigate({ search: {}, replace: true });
        // Not optimistic — only claim "deleted" once the server agrees
        // (failure is toasted by the mutation and the thread stays put).
        push('Thread deleted — its entries kept their other tags', { tone: 'info' });
      },
    });
  }

  // --- per-entry fetches with busy chips ---

  async function fetchText(id: string) {
    if (fetchingText.has(id)) return;
    setFetchingText((cur) => new Set(cur).add(id));
    try {
      const d = await mutations.fetchText.mutateAsync(id);
      const entry = state.entries.find((x) => x.id === id);
      if (d.doc) setAnnotator({ doc: d.doc, title: entry ? entry.text.slice(0, 60) : '' });
    } catch {
      // toasted by the mutation (incl. the PDF-specific message)
    } finally {
      setFetchingText((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  async function annotateSourceMeta(id: string) {
    if (annotatingMeta.has(id)) return;
    setAnnotatingMeta((cur) => new Set(cur).add(id));
    try {
      await mutations.annotateSource.mutateAsync(id);
    } catch {
      // toasted by the mutation
    } finally {
      setAnnotatingMeta((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  function fileUnfiled() {
    mutations.fileUnfiled.mutate(undefined, {
      onSuccess: (d) => {
        if (!d.unfiled) push('Nothing unfiled.', { tone: 'info' });
        else
          push(`Filer started on ${d.unfiled} ${plural(d.unfiled, 'entry', 'entries')} — it tags them into topics.`, {
            tone: 'info',
          });
      },
    });
  }

  function deepResearch(id: string) {
    mutations.deepResearch.mutate(id, {
      onSuccess: () => push('Deep research started — the report will land under the question.', { tone: 'info' }),
    });
  }

  const ctx: ResearchCtxValue = {
    state,
    byId,
    docTexts,
    library,
    edge,
    fetchingText,
    annotatingMeta,
    composer,
    setComposer,
    requestConfirm,
    confirmKey,
    mutations,
    push,
    actions: {
      addEntry: (extraTopicId) => void addEntry(extraTopicId),
      addAndResearch: (extraTopicId) => void addAndResearch(extraTopicId),
      startAnswer,
      cancelAnswer: () => setComposer((c) => ({ ...c, replyTo: null, reQuote: null, contextChain: null })),
      clearReQuote: () => setComposer((c) => ({ ...c, reQuote: null, contextChain: null })),
      toggleContext: (id) =>
        setComposer((c) =>
          c.contextChain
            ? { ...c, contextChain: c.contextChain.map((x) => (x.id === id ? { ...x, checked: !x.checked } : x)) }
            : c,
        ),
      startFollowUp,
      focusComposer,
      deleteEntry,
      deepResearch,
      fetchText: (id) => void fetchText(id),
      annotateSourceMeta: (id) => void annotateSourceMeta(id),
      deleteTopic,
      fileUnfiled,
      openThread,
      openLibraryFile: (path) => setReaderPath(path),
      openAnnotator: (doc, title) => setAnnotator({ doc, title }),
    },
  };

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>Research isn&rsquo;t available here.</div>
      </div>
    );
  }

  return (
    <ResearchProvider value={ctx}>
      <div className={styles.page}>
        <div className={styles.pageHead}>
          <h1 className={styles.pageTitle}>Research</h1>
          <span className={styles.pageSub}>what I&rsquo;m learning, what I trust, what&rsquo;s still open</span>
        </div>

        {researchQuery.isLoading ? (
          <div className={styles.loading}>Loading&hellip;</div>
        ) : researchQuery.isError && !researchQuery.data ? (
          <div className={styles.loading}>Couldn&rsquo;t load research.</div>
        ) : topic ? (
          <ThreadView topic={topic} />
        ) : (
          <>
            <Composer />
            <ThreadsDirectoryCard frontFilter={frontFilter} onFrontFilterChange={setFrontFilter} />
          </>
        )}
      </div>

      {readerPath ? (
        <Reader
          path={readerPath}
          onClose={() => setReaderPath(null)}
          onAnnotate={(doc, title) => {
            setReaderPath(null);
            setAnnotator({ doc, title });
          }}
        />
      ) : null}

      {annotator ? (
        <Annotator doc={annotator.doc} fallbackTitle={annotator.title} onClose={() => setAnnotator(null)} />
      ) : null}

      {/* Dev notes / ideas for the research page — same 'research' tab the
          old pinned panel wrote to. */}
      <NotesPill tab="research" onError={push} />
      <HealthPill inFlight={anySessionInFlight(state.sessions)} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ResearchProvider>
  );
}
