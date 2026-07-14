/**
 * useResearchData.ts — TanStack Query wiring for the research workspace.
 *
 * The legacy page kept one global R = {topics, entries, sessions} blob and
 * every CRUD endpoint returned the full state, so a successful post refreshed
 * R directly with no refetch. The query mirror of that: one ['research']
 * query; every blob-returning mutation writes its response straight into the
 * cache (applyBlob). Instant field flips (flag/review/verdict/status/topics)
 * are additionally optimistic with rollback.
 *
 * Polling: the old page polled /api/data/research every 5s while a runner
 * session was running/queued (started on send, capped at 10 min). Here the
 * query's refetchInterval turns itself on whenever the cached data shows an
 * in-flight session and off once nothing is — same effect, self-managing.
 * (No 10-minute cap: a stuck "running" session keeps a visible page polling;
 * background tabs don't poll at all.)
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as apiR from './api';
import { researchErrorMessage } from './api';
import { anySessionInFlight } from './helpers';
import { FRONTS_KEY, useFronts } from '../fronts/useFronts';
import type { Annotation, AnnotationContent, Entry, ResearchBlob, ResearchState } from './types';

// Re-exported for the research files that import the fronts query from here
// (ThreadView.tsx, ThreadsDirectory.tsx) — the hook itself now lives in the
// shared features/fronts module (see the header comment there).
export { FRONTS_KEY, useFronts };

export const RESEARCH_KEY = ['research'] as const;
export const LIBRARY_KEY = ['research', 'library'] as const;
export const TEXTS_KEY = ['research', 'texts'] as const;
export const annotationsKey = (doc: string) => ['annotations', doc] as const;
export const docTextKey = (doc: string) => ['annotations', 'doc-text', doc] as const;

type PushToast = (message: string, opts?: { tone?: 'error' | 'info' }) => void;

function normalize(blob: Partial<ResearchState> | undefined): ResearchState {
  return {
    topics: blob?.topics ?? [],
    entries: blob?.entries ?? [],
    sessions: blob?.sessions ?? [],
  };
}

/** Every research CRUD endpoint returns the full state — write it through. */
export function applyBlob(queryClient: QueryClient, blob: ResearchBlob | undefined): void {
  if (blob && Array.isArray(blob.topics)) {
    queryClient.setQueryData(RESEARCH_KEY, normalize(blob));
  }
}

export function useResearch() {
  return useQuery({
    queryKey: RESEARCH_KEY,
    queryFn: async ({ signal }) => normalize((await apiR.getResearch(signal)).research),
    // Old page refetched on every tab-return/focus — don't let staleTime gate it.
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data && anySessionInFlight(query.state.data.sessions) ? 5_000 : false,
  });
}

export function useLibrary() {
  return useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: async ({ signal }) => {
      const body = await apiR.getLibrary(signal);
      return { files: body.files ?? [], edge: body.edge ?? [] };
    },
  });
}

export function useDocTexts() {
  return useQuery({
    queryKey: TEXTS_KEY,
    queryFn: async ({ signal }) => (await apiR.getDocTexts(signal)).docs ?? [],
  });
}

// --- Blob mutations ---------------------------------------------------------

interface BlobMutationOpts<V> {
  mutationFn: (vars: V) => Promise<ResearchBlob>;
  errorFallback: string;
  /** name for the "X API not loaded yet" 404 mapping, if this endpoint is new */
  notLoadedName?: string;
  /** optimistic patch applied to the cached state before the request lands */
  optimistic?: (state: ResearchState, vars: V) => ResearchState;
  onDone?: (blob: ResearchBlob, vars: V) => void;
}

function useBlobMutation<V>(push: PushToast, opts: BlobMutationOpts<V>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars: V) => {
      if (!opts.optimistic) return {};
      await queryClient.cancelQueries({ queryKey: RESEARCH_KEY });
      const previous = queryClient.getQueryData<ResearchState>(RESEARCH_KEY);
      if (previous) {
        queryClient.setQueryData(RESEARCH_KEY, opts.optimistic(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(RESEARCH_KEY, ctx.previous);
      push(researchErrorMessage(err, opts.errorFallback, opts.notLoadedName));
    },
    onSuccess: (blob, vars) => {
      applyBlob(queryClient, blob);
      opts.onDone?.(blob, vars);
    },
  });
}

function patchEntry(state: ResearchState, id: string, patch: Partial<Entry>): ResearchState {
  return {
    ...state,
    entries: state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  };
}

export function useResearchMutations(push: PushToast) {
  const queryClient = useQueryClient();

  // --- Topics ---
  const addTopic = useBlobMutation<{ name: string; fronts?: string[] }>(push, {
    mutationFn: ({ name, fronts }) => apiR.addTopic(name, fronts),
    errorFallback: 'Save failed.',
  });
  const editTopic = useBlobMutation<{ id: string; name?: string; status?: string; fronts?: string[] }>(push, {
    mutationFn: (body) => apiR.editTopic(body),
    errorFallback: 'Save failed.',
    optimistic: (state, body) => ({
      ...state,
      topics: state.topics.map((t) =>
        t.id === body.id
          ? {
              ...t,
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.status !== undefined ? { status: body.status } : {}),
              ...(body.fronts !== undefined ? { fronts: body.fronts } : {}),
            }
          : t,
      ),
    }),
  });
  const removeTopic = useBlobMutation<string>(push, {
    mutationFn: (id) => apiR.removeTopic(id),
    errorFallback: 'Save failed.',
  });

  // --- Entries ---
  const addEntry = useBlobMutation<apiR.AddEntryBody>(push, {
    mutationFn: (body) => apiR.addEntry(body),
    errorFallback: 'Save failed.',
  });
  const editEntry = useBlobMutation<apiR.EditEntryBody>(push, {
    mutationFn: (body) => apiR.editEntry(body),
    errorFallback: 'Save failed.',
    optimistic: (state, body) => {
      const { id, ...patch } = body;
      return patchEntry(state, id, patch);
    },
  });
  const removeEntry = useBlobMutation<string>(push, {
    mutationFn: (id) => apiR.removeEntry(id),
    errorFallback: 'Save failed.',
    optimistic: (state, id) => ({ ...state, entries: state.entries.filter((e) => e.id !== id) }),
  });
  const flagEntry = useBlobMutation<{ id: string; flagged: boolean }>(push, {
    mutationFn: ({ id, flagged }) => apiR.flagEntry(id, flagged),
    errorFallback: 'Could not flag.',
    notLoadedName: 'Flag',
    optimistic: (state, { id, flagged }) => patchEntry(state, id, { flagged }),
  });
  const reviewEntry = useBlobMutation<{ id: string; reviewed: boolean }>(push, {
    mutationFn: ({ id, reviewed }) => apiR.reviewEntry(id, reviewed),
    errorFallback: 'Could not mark reviewed.',
    notLoadedName: 'Review',
    optimistic: (state, { id, reviewed }) => patchEntry(state, id, { reviewed }),
  });

  // --- Source metadata + full text ---
  const annotateSource = useBlobMutation<string>(push, {
    mutationFn: (id) => apiR.annotateSource(id),
    errorFallback: 'Could not fetch metadata.',
  });
  const metaReview = useBlobMutation<{ id: string; reviewed: boolean }>(push, {
    mutationFn: ({ id, reviewed }) => apiR.metaReview(id, reviewed),
    errorFallback: 'Save failed.',
    optimistic: (state, { id, reviewed }) => ({
      ...state,
      entries: state.entries.map((e) =>
        e.id === id && e.meta ? { ...e, meta: { ...e.meta, reviewed } } : e,
      ),
    }),
  });

  const fetchText = useMutation({
    mutationFn: (id: string) => apiR.fetchEntryText(id),
    onSuccess: (body) => {
      if (body.doc) {
        queryClient.setQueryData<string[]>(TEXTS_KEY, (docs) =>
          docs && !docs.includes(body.doc) ? [...docs, body.doc] : (docs ?? [body.doc]),
        );
      }
    },
    onError: (err) => {
      const msg = researchErrorMessage(err, 'Could not fetch text.');
      push(
        msg === 'pdf_extraction_unavailable'
          ? "That source is a PDF — PDF text extraction isn't wired up yet."
          : msg,
      );
    },
  });

  // --- Runner sessions ---
  const invalidateResearch = () => void queryClient.invalidateQueries({ queryKey: RESEARCH_KEY });

  const send = useMutation({
    mutationFn: (ids: string[] | null) => apiR.sendEntries(ids),
    onSuccess: (body) => {
      invalidateResearch();
      if (body.sent > 0) push(`Sent ${body.sent} to Claude — replies land in the thread.`, { tone: 'info' });
    },
    onError: (err) => push(researchErrorMessage(err, 'Could not send.', 'Send')),
  });

  const deepResearch = useMutation({
    mutationFn: (id: string) => apiR.deepResearchQuestion(id),
    onSuccess: () => invalidateResearch(),
    onError: (err) => push(researchErrorMessage(err, 'Could not start deep research.', 'Deep research')),
  });

  const distill = useBlobMutation<string>(push, {
    mutationFn: (topic) => apiR.distillTopic(topic),
    errorFallback: 'Could not start distill.',
    notLoadedName: 'Distill',
  });

  const annotationBatchMut = useMutation({
    mutationFn: (items: apiR.AnnotationBatchItem[]) => apiR.annotationBatch(items),
    onSuccess: () => invalidateResearch(),
  });

  const fileUnfiledMut = useMutation({
    mutationFn: () => apiR.fileUnfiled(),
    onError: (err) => push(researchErrorMessage(err, 'Could not start the filer.', 'Filer')),
  });

  const importQuestionsMut = useMutation({
    mutationFn: (dryRun: boolean) => apiR.importQuestions(dryRun),
    onSuccess: (body, dryRun) => {
      if (!dryRun && Array.isArray(body.topics)) {
        queryClient.setQueryData(RESEARCH_KEY, normalize(body as Partial<ResearchState>));
      }
    },
    onError: (err, dryRun) =>
      push(researchErrorMessage(err, dryRun ? 'Import preview failed.' : 'Import failed.', 'Import')),
  });

  return {
    addTopic,
    editTopic,
    removeTopic,
    addEntry,
    editEntry,
    removeEntry,
    flagEntry,
    reviewEntry,
    annotateSource,
    metaReview,
    fetchText,
    send,
    deepResearch,
    distill,
    annotationBatch: annotationBatchMut,
    fileUnfiled: fileUnfiledMut,
    importQuestions: importQuestionsMut,
  };
}

export type ResearchMutations = ReturnType<typeof useResearchMutations>;

// --- Annotator --------------------------------------------------------------

export function useDocText(doc: string | null) {
  return useQuery({
    queryKey: docTextKey(doc ?? ''),
    queryFn: ({ signal }) => apiR.getDocText(doc!, signal),
    enabled: doc !== null,
    retry: false,
    staleTime: 0,
  });
}

export function useAnnotations(doc: string | null) {
  return useQuery({
    queryKey: annotationsKey(doc ?? ''),
    queryFn: async ({ signal }) => (await apiR.getAnnotations(doc!, signal)).annotations ?? [],
    enabled: doc !== null,
    staleTime: 0,
  });
}

/** Annotation endpoints return the doc-scoped list — write it through. */
export function useAnnotationMutations(doc: string, push: PushToast) {
  const queryClient = useQueryClient();

  const applyList = (body: { doc?: string; annotations?: Annotation[] }) => {
    if (body.annotations && (!body.doc || body.doc === doc)) {
      queryClient.setQueryData(annotationsKey(doc), body.annotations);
    }
  };

  const add = useMutation({
    mutationFn: (body: { char_start: number; char_end: number; content: AnnotationContent; needs_review?: boolean }) =>
      apiR.addAnnotation({ doc, ...body }),
    onSuccess: (body) => {
      applyList(body);
      // Highlighting one of claude's answers marks it reviewed server-side —
      // refresh so its row settles orange -> purple behind the overlay.
      void queryClient.invalidateQueries({ queryKey: RESEARCH_KEY });
    },
    onError: (err) => push(researchErrorMessage(err, 'Save failed.')),
  });

  const edit = useMutation({
    mutationFn: (body: { id: string; content?: AnnotationContent; needs_review?: boolean }) =>
      apiR.editAnnotation(body),
    onSuccess: applyList,
    onError: (err) => push(researchErrorMessage(err, 'Save failed.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiR.removeAnnotation(id),
    onSuccess: applyList,
    onError: (err) => push(researchErrorMessage(err, 'Save failed.')),
  });

  return { add, edit, remove };
}
