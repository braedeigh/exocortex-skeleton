import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { addIdeaNote, editIdeaNote, getAllIdeaNotes, removeIdeaNote } from '../../api/endpoints';
import type { AllNotesResponse, DevNote } from '../journal/types';
import { getIdeasDoc, restoreIdeaNote, saveIdeasDoc } from './api';

/** Same key the /notes browser uses (useNotesBrowser) — the two surfaces
 * share one cache, and the pill's mutations already invalidate it. */
export const IDEA_NOTES_KEY = ['notesAll', 'idea'] as const;
export const IDEAS_DOC_KEY = ['ideasDoc'] as const;

/** Legacy core.js polled the dashboard every 5s; keep that cadence. */
const POLL_MS = 5000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function useIdeaNotesAll(enabled = true) {
  return useQuery({
    queryKey: IDEA_NOTES_KEY,
    queryFn: ({ signal }) => getAllIdeaNotes(signal),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useIdeasDoc(enabled = true) {
  return useQuery({
    queryKey: IDEAS_DOC_KEY,
    queryFn: ({ signal }) => getIdeasDoc(signal),
    refetchInterval: POLL_MS,
    enabled,
  });
}

/** Everything needed to undo a delete exactly (the legacy _noteApply undo
 * POSTed the full note + its original index to /api/ideanote/restore). */
export interface RemovedIdea {
  tab: string;
  note: DevNote;
  index: number;
}

function withTab(data: AllNotesResponse, tab: string, notes: DevNote[]): AllNotesResponse {
  return { ...data, tabs: { ...data.tabs, [tab]: notes } };
}

/**
 * Add / edit / remove / restore for the by-page idea lists, all acting on the
 * shared ['notesAll','idea'] cache. Edit and remove are optimistic (the row
 * updates/disappears immediately, rolled back on error); a successful remove
 * reports the removed note + index through `onRemoved` together with an
 * `undo` closure, which the page turns into the "Idea removed · Undo" toast.
 */
export function useIdeaMutations(
  onError: (message: string) => void,
  onRemoved: (removed: RemovedIdea, undo: () => void) => void,
) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: IDEA_NOTES_KEY });
    // Per-tab pill lists (['notesPill','idea',<tab>]) show the same notes.
    void queryClient.invalidateQueries({ queryKey: ['notesPill', 'idea'] });
  };

  const add = useMutation({
    mutationFn: (vars: { tab: string; text: string }) => addIdeaNote(vars.tab, vars.text),
    onError: (err) => onError(errorMessage(err, "Couldn't add idea")),
    onSuccess: () => invalidate(),
  });

  const edit = useMutation({
    mutationFn: (vars: { tab: string; id: string; text: string }) => editIdeaNote(vars.tab, vars.id, vars.text),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: IDEA_NOTES_KEY });
      const previous = queryClient.getQueryData<AllNotesResponse>(IDEA_NOTES_KEY);
      if (previous) {
        const notes = (previous.tabs[vars.tab] || []).map((n) => (n.id === vars.id ? { ...n, text: vars.text } : n));
        queryClient.setQueryData<AllNotesResponse>(IDEA_NOTES_KEY, withTab(previous, vars.tab, notes));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(IDEA_NOTES_KEY, context.previous);
      onError(errorMessage(err, "Couldn't save idea"));
    },
    onSettled: () => invalidate(),
  });

  const restore = useMutation({
    mutationFn: (removed: RemovedIdea) => restoreIdeaNote(removed.tab, removed.note, removed.index),
    onError: (err) => onError(errorMessage(err, "Couldn't restore idea")),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (vars: { tab: string; id: string }) => removeIdeaNote(vars.tab, vars.id),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: IDEA_NOTES_KEY });
      const previous = queryClient.getQueryData<AllNotesResponse>(IDEA_NOTES_KEY);
      let removed: RemovedIdea | null = null;
      if (previous) {
        const notes = previous.tabs[vars.tab] || [];
        const index = notes.findIndex((n) => n.id === vars.id);
        if (index !== -1) {
          removed = { tab: vars.tab, note: notes[index], index };
          queryClient.setQueryData<AllNotesResponse>(
            IDEA_NOTES_KEY,
            withTab(
              previous,
              vars.tab,
              notes.filter((n) => n.id !== vars.id),
            ),
          );
        }
      }
      return { previous, removed };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(IDEA_NOTES_KEY, context.previous);
      onError(errorMessage(err, "Couldn't delete idea"));
    },
    onSuccess: (_data, _vars, context) => {
      const removed = context?.removed;
      if (removed) onRemoved(removed, () => restore.mutate(removed));
    },
    onSettled: () => invalidate(),
  });

  return {
    add: (tab: string, text: string) => add.mutate({ tab, text }),
    edit: (tab: string, id: string, text: string) => edit.mutate({ tab, id, text }),
    remove: (tab: string, id: string) => remove.mutate({ tab, id }),
  };
}

/** Whole-doc save for IDEAS.md. On success the cache takes the saved content
 * directly (no refetch flicker); on error the server's reason — e.g. the
 * "refusing to overwrite the ideas doc with nothing" guard — is toasted and
 * the editor stays open (the legacy page alert()ed and did the same). */
export function useIdeasDocSave(onError: (message: string) => void, onSaved: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => saveIdeasDoc(content),
    onError: (err) => onError(errorMessage(err, 'Save failed')),
    onSuccess: (_data, content) => {
      queryClient.setQueryData(IDEAS_DOC_KEY, { content });
      onSaved();
    },
  });
}
