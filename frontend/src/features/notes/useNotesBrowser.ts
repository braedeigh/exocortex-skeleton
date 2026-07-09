import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  editDevNote,
  editIdeaNote,
  getAllDevNotes,
  getAllIdeaNotes,
  removeDevNote,
  removeIdeaNote,
} from '../../api/endpoints';
import type { DevNote } from '../journal/types';
import type { NotesPillKind } from '../todos/useNotesPill';

export type NotesBrowserKind = NotesPillKind;

/** A note flattened out of the {tabs: {tab: DevNote[]}} /all response,
 * tagged with the tab and kind it came from — everything a mutation needs
 * to act on it via the existing per-tab endpoints. */
export interface FlatNote extends DevNote {
  tab: string;
  kind: NotesBrowserKind;
}

function queryKey(kind: NotesBrowserKind) {
  return ['notesAll', kind] as const;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** `enabled` lets callers (the /notes page, gated by public mode) skip the
 * network request while still calling the hook unconditionally. */
export function useAllNotes(kind: NotesBrowserKind, enabled = true) {
  return useQuery({
    queryKey: queryKey(kind),
    queryFn: ({ signal }) => (kind === 'idea' ? getAllIdeaNotes(signal) : getAllDevNotes(signal)),
    enabled,
  });
}

export function flattenNotes(tabs: Record<string, DevNote[]> | undefined, kind: NotesBrowserKind): FlatNote[] {
  if (!tabs) return [];
  const out: FlatNote[] = [];
  for (const [tab, notes] of Object.entries(tabs)) {
    for (const n of notes) out.push({ ...n, tab, kind });
  }
  return out;
}

export function useNotesBrowserMutations(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = (kind: NotesBrowserKind) => queryClient.invalidateQueries({ queryKey: queryKey(kind) });

  const edit = useMutation({
    mutationFn: (vars: { kind: NotesBrowserKind; tab: string; id: string; text: string }) =>
      vars.kind === 'idea' ? editIdeaNote(vars.tab, vars.id, vars.text) : editDevNote(vars.tab, vars.id, vars.text),
    onError: (err) => onError(errorMessage(err, "Couldn't save note")),
    onSuccess: (_data, vars) => void invalidate(vars.kind),
  });
  const remove = useMutation({
    mutationFn: (vars: { kind: NotesBrowserKind; tab: string; id: string }) =>
      vars.kind === 'idea' ? removeIdeaNote(vars.tab, vars.id) : removeDevNote(vars.tab, vars.id),
    onError: (err) => onError(errorMessage(err, "Couldn't delete note")),
    onSuccess: (_data, vars) => void invalidate(vars.kind),
  });

  return {
    edit: (kind: NotesBrowserKind, tab: string, id: string, text: string) => edit.mutate({ kind, tab, id, text }),
    remove: (kind: NotesBrowserKind, tab: string, id: string) => remove.mutate({ kind, tab, id }),
  };
}
