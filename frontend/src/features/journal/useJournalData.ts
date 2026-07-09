import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
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
  deleteCard as deleteCardRequest,
} from '../../api/endpoints';
import type { JournalDayBundle } from './types';

export const JOURNAL_DATES_KEY = ['journal', 'dates'] as const;
export const JOURNAL_PEOPLE_KEY = ['journal', 'people'] as const;
export const JOURNAL_DEVNOTES_KEY = ['journal', 'devnotes'] as const;

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
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, opts?: PushOptions) => {
    const id = nextId.current++;
    setToasts((cur) => [
      ...cur,
      { id, message, tone: opts?.tone ?? 'error', actionLabel: opts?.actionLabel, onAction: opts?.onAction },
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
