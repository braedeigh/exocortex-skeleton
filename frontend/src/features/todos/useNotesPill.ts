import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  addDevNote,
  addIdeaNote,
  editDevNote,
  editIdeaNote,
  getDevNotes,
  getIdeaNotes,
  removeDevNote,
  removeIdeaNote,
} from '../../api/endpoints';

export type NotesPillKind = 'dev' | 'idea';

export interface NotesPillNote {
  id: string;
  text: string;
  created: string;
}

/**
 * Tab the pill acts on. The legacy notes-pill.js followed core.js's
 * `currentTab` across every dashboard tab it was mounted on; the native
 * /todos page only ever shows one tab's worth of content, so this is fixed
 * rather than tracked.
 */
const TAB = 'today';

function notesQueryKey(kind: NotesPillKind) {
  return ['notesPill', kind, TAB] as const;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function useNotesPillList(kind: NotesPillKind) {
  return useQuery({
    queryKey: notesQueryKey(kind),
    queryFn: ({ signal }) => (kind === 'idea' ? getIdeaNotes(TAB, signal) : getDevNotes(TAB, signal)),
  });
}

export function useNotesPillMutations(kind: NotesPillKind, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: notesQueryKey(kind) });

  const add = useMutation({
    mutationFn: (text: string) => (kind === 'idea' ? addIdeaNote(TAB, text) : addDevNote(TAB, text)),
    onError: (err) => onError(errorMessage(err, "Couldn't add note")),
    onSuccess: () => void invalidate(),
  });
  const edit = useMutation({
    mutationFn: (vars: { id: string; text: string }) =>
      kind === 'idea' ? editIdeaNote(TAB, vars.id, vars.text) : editDevNote(TAB, vars.id, vars.text),
    onError: (err) => onError(errorMessage(err, "Couldn't save note")),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => (kind === 'idea' ? removeIdeaNote(TAB, id) : removeDevNote(TAB, id)),
    onError: (err) => onError(errorMessage(err, "Couldn't delete note")),
    onSuccess: () => void invalidate(),
  });

  return {
    add: (text: string) => add.mutate(text),
    edit: (id: string, text: string) => edit.mutate({ id, text }),
    remove: (id: string) => remove.mutate(id),
  };
}
