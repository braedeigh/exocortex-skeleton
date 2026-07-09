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

function notesQueryKey(kind: NotesPillKind, tab: string) {
  return ['notesPill', kind, tab] as const;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * `tab` is which page's notes the pill acts on. The legacy notes-pill.js
 * followed core.js's `currentTab` across every dashboard tab it was mounted
 * on; each native page mounts its own pill with a fixed tab instead
 * ('today' on /todos, 'notes' on /notes).
 */
export function useNotesPillList(kind: NotesPillKind, tab: string) {
  return useQuery({
    queryKey: notesQueryKey(kind, tab),
    queryFn: ({ signal }) => (kind === 'idea' ? getIdeaNotes(tab, signal) : getDevNotes(tab, signal)),
  });
}

export function useNotesPillMutations(kind: NotesPillKind, tab: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: notesQueryKey(kind, tab) });
    // The /notes browser shows every tab's notes — keep it fresh too.
    void queryClient.invalidateQueries({ queryKey: ['notesAll', kind] });
  };

  const add = useMutation({
    mutationFn: (text: string) => (kind === 'idea' ? addIdeaNote(tab, text) : addDevNote(tab, text)),
    onError: (err) => onError(errorMessage(err, "Couldn't add note")),
    onSuccess: () => void invalidate(),
  });
  const edit = useMutation({
    mutationFn: (vars: { id: string; text: string }) =>
      kind === 'idea' ? editIdeaNote(tab, vars.id, vars.text) : editDevNote(tab, vars.id, vars.text),
    onError: (err) => onError(errorMessage(err, "Couldn't save note")),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => (kind === 'idea' ? removeIdeaNote(tab, id) : removeDevNote(tab, id)),
    onError: (err) => onError(errorMessage(err, "Couldn't delete note")),
    onSuccess: () => void invalidate(),
  });

  return {
    add: (text: string) => add.mutate(text),
    edit: (id: string, text: string) => edit.mutate({ id, text }),
    remove: (id: string) => remove.mutate(id),
  };
}
