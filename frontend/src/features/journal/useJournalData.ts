import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import {
  addJournalDevNote,
  editJournalDevNote,
  getAppData,
  getBacklinks,
  getCards,
  getJournalDates,
  getJournalDay,
  getJournalDevNotes,
  getPeople,
  removeJournalDevNote,
  saveJournalDay,
  updateCard,
  addCard,
  deleteCard as deleteCardRequest,
} from '../../api/endpoints';
import type { JournalDayBundle, ThreadDetail, ThreadsResponse, ThreadsTreeResponse } from './types';

export const JOURNAL_DATES_KEY = ['journal', 'dates'] as const;
export const JOURNAL_PEOPLE_KEY = ['journal', 'people'] as const;
export const JOURNAL_THREADS_KEY = ['journal', 'threads'] as const;
export const JOURNAL_DEVNOTES_KEY = ['journal', 'devnotes'] as const;

// Threads fetchers live here (not api/endpoints.ts) because only the journal
// feature consumes them today; hoist to endpoints.ts if another feature (e.g.
// a future Threads page) needs them.

/** GET /api/threads — roster for the highlighter + Threads launcher panel.
 * `?include=retired` also returns `status: retired` threads (routes/threads.py). */
function getThreads(includeRetired: boolean, signal?: AbortSignal): Promise<ThreadsResponse> {
  return api.get(includeRetired ? '/api/threads?include=retired' : '/api/threads', signal);
}

/** GET /api/threads/tree — the derived parent/child DAG (threads-architecture.md
 * §7): `{roots, nodes}`, rebuilt fresh per request from `parents:` edges. */
function getThreadsTree(includeRetired: boolean, signal?: AbortSignal): Promise<ThreadsTreeResponse> {
  return api.get(includeRetired ? '/api/threads/tree?include=retired' : '/api/threads/tree', signal);
}

/** GET /api/thread?name=<slug|name|alias> — one thread's parsed fact-cards. */
function getThread(name: string, signal?: AbortSignal): Promise<ThreadDetail> {
  return api.get(`/api/thread?name=${encodeURIComponent(name)}`, signal);
}

export function journalDayKey(date: string) {
  return ['journal', 'day', date] as const;
}

/** Server's notion of "today" — the only source of truth for it (never client Date). */
export function useServerDate() {
  return useQuery({
    queryKey: ['journal', 'serverDate'],
    queryFn: ({ signal }) => getAppData(signal),
  });
}

export function useJournalDates() {
  return useQuery({
    queryKey: JOURNAL_DATES_KEY,
    queryFn: ({ signal }) => getJournalDates(signal),
  });
}

/**
 * One day's journal + cards, bundled into a single query so the two always
 * update together. Polls every 3s (the keeper hook re-renders after every
 * message) unless `pausePolling` is set — while the blob editor is focused
 * or a card edit is open, an incoming poll must never yank text out from
 * under her.
 */
export function useJournalDay(date: string | null, pausePolling: boolean) {
  return useQuery({
    queryKey: journalDayKey(date ?? ''),
    queryFn: async ({ signal }): Promise<JournalDayBundle> => {
      const [journal, cards] = await Promise.all([getJournalDay(date as string, signal), getCards(date as string, signal)]);
      return { journal, cards };
    },
    enabled: !!date,
    refetchInterval: pausePolling ? false : 3000,
  });
}

export function usePeople() {
  return useQuery({
    queryKey: JOURNAL_PEOPLE_KEY,
    queryFn: ({ signal }) => getPeople(signal),
    staleTime: 10 * 60_000,
  });
}

export function useThreads(includeRetired = false) {
  return useQuery({
    queryKey: includeRetired ? [...JOURNAL_THREADS_KEY, 'retired'] : JOURNAL_THREADS_KEY,
    queryFn: ({ signal }) => getThreads(includeRetired, signal),
    staleTime: 10 * 60_000,
  });
}

/** The derived DAG (routes/threads.py threads_tree) — roots + a slug-keyed
 * node map, `?include=retired` when the page's "Show retired" toggle is on. */
export function useThreadsTree(includeRetired = false) {
  return useQuery({
    queryKey: includeRetired ? ['journal', 'threadsTree', 'retired'] : ['journal', 'threadsTree'],
    queryFn: ({ signal }) => getThreadsTree(includeRetired, signal),
    staleTime: 10 * 60_000,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: ['journal', 'thread', id ?? ''],
    queryFn: ({ signal }) => getThread(id as string, signal),
    enabled: !!id,
  });
}

export function useBacklinks(name: string | null) {
  return useQuery({
    queryKey: ['journal', 'backlinks', name ?? ''],
    queryFn: ({ signal }) => getBacklinks(name as string, signal),
    enabled: !!name,
  });
}

export function useJournalDevNotes() {
  return useQuery({
    queryKey: JOURNAL_DEVNOTES_KEY,
    queryFn: ({ signal }) => getJournalDevNotes(signal),
  });
}

export type Toast = ToastItem;

export interface PushOptions {
  /** 'error' (default, red) or 'info' (neutral — e.g. paired with an undo action). */
  tone?: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay in ms (default 5000). */
  duration?: number;
  /** Tapping the toast's message text does this — separate from the Undo action. */
  onMessageTap?: () => void;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, opts?: PushOptions) => {
    const id = nextId.current++;
    setToasts((cur) => [
      ...cur,
      {
        id,
        message,
        tone: opts?.tone ?? 'error',
        actionLabel: opts?.actionLabel,
        onAction: opts?.onAction,
        onMessageTap: opts?.onMessageTap,
      },
    ]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), opts?.duration ?? 5000);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Debounced whole-day autosave for markdown-blob mode (pre-cutover days). */
export function useSaveJournalBlob(date: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => saveJournalDay(date, content),
    onError: (err) => onError(errorMessage(err, 'Save failed')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: journalDayKey(date) });
    },
  });
}

export function useUpdateCard(date: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: string }) => updateCard(vars.id, vars.body),
    onError: (err) => onError(errorMessage(err, 'Save failed')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: journalDayKey(date) });
    },
  });
}

export function useAddCard(date: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { position: 'top' | 'bottom'; body: string }) => addCard(date, vars.position, vars.body),
    onError: (err) => onError(errorMessage(err, 'Add failed')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: journalDayKey(date) });
    },
  });
}

export function useDeleteCard(date: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; wasLastCard: boolean }) => deleteCardRequest(vars.id),
    onError: (err) => onError(errorMessage(err, 'Delete failed')),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: journalDayKey(date) });
      if (vars.wasLastCard) {
        // The calendar dot for this day may be gone now.
        void queryClient.invalidateQueries({ queryKey: JOURNAL_DATES_KEY });
      }
    },
  });
}

export function useDevNoteMutations(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: JOURNAL_DEVNOTES_KEY });

  const add = useMutation({
    mutationFn: (text: string) => addJournalDevNote(text),
    onError: (err) => onError(errorMessage(err, "Couldn't add note")),
    onSuccess: () => void invalidate(),
  });
  const edit = useMutation({
    mutationFn: (vars: { id: string; text: string }) => editJournalDevNote(vars.id, vars.text),
    onError: (err) => onError(errorMessage(err, "Couldn't save note")),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeJournalDevNote(id),
    onError: (err) => onError(errorMessage(err, "Couldn't delete note")),
    onSuccess: () => void invalidate(),
  });

  return {
    add: (text: string) => add.mutate(text),
    edit: (id: string, text: string) => edit.mutate({ id, text }),
    remove: (id: string) => remove.mutate(id),
  };
}
