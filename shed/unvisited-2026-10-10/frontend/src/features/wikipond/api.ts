/**
 * api.ts — typed reads and writes for the wiki-pond (routes/wiki.py,
 * routes/tags.py).
 *
 * Plain English: one query for the picture (every tagged row in a window,
 * plus the rail of namespaces to light them by) and two mutations for the
 * one thing this page lets her change — a subject's tags. Modelled on
 * features/terrain/pond/api.ts's react-query style: typed responses, `staleTime` so
 * panning around doesn't re-fetch on every render, and mutations that
 * invalidate exactly what they can affect so the drawing and the popover
 * never go stale relative to each other.
 *
 * Unlike the pond, there's no separate "card detail" query here — GET
 * /api/wiki/pond already sends every row's full body/title inline (see the
 * design doc's payload shape), so tapping a row never needs a second fetch
 * for its content. The one thing that DOES need its own query is a row's
 * live tag list: the popover reads it fresh via useSubjectTags rather than
 * trusting the row's tags as they were at the last pond fetch, because it's
 * also the surface that can just have changed them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { WikiRailNs, WikiRow } from './wikiPondMath';

export interface WikiPondPayload {
  start: string;
  end: string;
  rows: WikiRow[];
  rail: WikiRailNs[];
}

/** GET /api/wiki/pond?days=&end= — every tagged row in the window, plus the
 * rail. `end` null means "today", same default the API itself uses. */
export function useWikiPond(days: number, end: string | null = null) {
  return useQuery({
    queryKey: ['wiki', 'pond', days, end],
    queryFn: () => {
      const params = new URLSearchParams({ days: String(days) });
      if (end) params.set('end', end);
      return api.get<WikiPondPayload>(`/api/wiki/pond?${params.toString()}`);
    },
    staleTime: 60_000,
  });
}

export type TagSource = 'manual' | 'derived' | 'cricket';

export interface SubjectTag {
  ns: string;
  tag: string;
  source: TagSource;
}

export interface SubjectTagsPayload {
  subject: string;
  tags: SubjectTag[];
}

/** GET /api/tags/for?subject=<subject> — the live tag list for one row,
 * fetched fresh rather than trusted from the pond payload (see file block). */
export function useSubjectTags(subject: string | null) {
  return useQuery({
    queryKey: ['tags', 'for', subject],
    queryFn: () => api.get<SubjectTagsPayload>(`/api/tags/for?subject=${encodeURIComponent(subject!)}`),
    enabled: subject !== null,
    staleTime: 30_000,
  });
}

interface TagWrite {
  subject: string;
  ns: string;
  tag: string;
}

/** Shared by add/remove: both touch the same two things — the wiki-pond
 * drawing (a chip's count and dot changed) and this subject's own tag list
 * (the popover reading it). Invalidating by the queryKey PREFIX (`['wiki',
 * 'pond']` rather than the full key with its days/end) catches every window
 * she might have open, same pattern api.ts in the pond uses for `['pond']`. */
function invalidateAfterTagWrite(queryClient: ReturnType<typeof useQueryClient>, subject: string) {
  queryClient.invalidateQueries({ queryKey: ['wiki', 'pond'] });
  queryClient.invalidateQueries({ queryKey: ['tags', 'for', subject] });
}

/** POST /api/tags/add {subject, ns, tag} → the subject's tags (source
 * becomes 'manual' — the write door's own rule, not this file's). */
export function useAddTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TagWrite) => api.post<SubjectTagsPayload>('/api/tags/add', vars),
    onSuccess: (_data, vars) => invalidateAfterTagWrite(queryClient, vars.subject),
  });
}

/** POST /api/tags/remove {subject, ns, tag} → the subject's tags. */
export function useRemoveTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TagWrite) => api.post<SubjectTagsPayload>('/api/tags/remove', vars),
    onSuccess: (_data, vars) => invalidateAfterTagWrite(queryClient, vars.subject),
  });
}
