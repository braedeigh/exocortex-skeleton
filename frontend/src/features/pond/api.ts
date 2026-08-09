/**
 * api.ts — typed reads for the pond (routes/pond.py).
 *
 * Three queries, matching the three endpoints: the threads ranked by span, the
 * cards in a window, and one card in full when she taps it. All read-only —
 * the card pool in the vault is the record and this is a mirror of it.
 *
 * The card detail is its own query on purpose rather than riding along in the
 * list: bodies are the bulk of the data and she reads one at a time, so the
 * list stays small enough to pan smoothly and the body is fetched (and then
 * cached by react-query) only for the card actually opened.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PondCard } from './pondMath';

/** Which shelf the vault filed a tag on — a file in `people/`, a file in
 * `Threads/`, or neither. The rail splits on this instead of listing ninety
 * tags in one undifferentiated run. */
export type PondKind = 'person' | 'thread' | 'topic';

export interface PondThread {
  tag: string;
  /** How many cards carry the tag. */
  cards: number;
  /** How many distinct DAYS it touches — what the list is ranked by. */
  days: number;
  first: string;
  last: string;
  kind: PondKind;
  /** Display name — the thread's `name:`, a person's slug cased, else the tag. */
  name: string;
  /** Fronts this thread belongs to (threads only; from its frontmatter). */
  fronts: string[];
  status: string | null;
  /** The tag's slug, name and aliases broken into searchable words — what a
   * long card's excerpt centres on when this thread is lit. */
  terms: string[];
}

/** A front — a life domain, holding the threads filed under it. Lighting one
 * lights all its threads at once, so `days` is the union of theirs, not a sum. */
export interface PondFront {
  id: string;
  name: string;
  tags: string[];
  days: number;
  cards: number;
}

export interface PondCardsPayload {
  cards: PondCard[];
  from: string | null;
  to: string | null;
  tag: string | null;
  /** The window held more cards than the server will send at once. */
  truncated: boolean;
}

export interface PondCardDetail extends PondCard {
  body: string;
  reply_to: string | null;
  session: string | null;
  refs: string | null;
  first_seen: string;
  last_seen: string;
}

export function usePondThreads() {
  return useQuery({
    queryKey: ['pond', 'threads'],
    queryFn: () =>
      api.get<{ threads: PondThread[]; fronts: PondFront[] }>('/api/pond/threads'),
    staleTime: 60_000,
  });
}

/** Every card in the pond. Not filtered by the lit thread: lighting one is a
 * change of emphasis, not of subject — the rest of the pond stays visible
 * around it, which is the whole point of seeing a thread in context. */
export function usePondCards() {
  return useQuery({
    queryKey: ['pond', 'cards'],
    queryFn: () => api.get<PondCardsPayload>('/api/pond/cards'),
    staleTime: 60_000,
  });
}

export function usePondCard(id: string | null) {
  return useQuery({
    queryKey: ['pond', 'card', id],
    queryFn: () => api.get<{ card: PondCardDetail }>(`/api/pond/card/${id}`),
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
}

/**
 * Put a card into a thread, or take it out — the one WRITE the pond makes.
 *
 * It doesn't get its own endpoint: tags are how a card joins a thread
 * everywhere in the system, and POST /api/cards/tag|untag (routes/cards.py)
 * already does this properly — through the vault's own stream.py, which
 * re-renders the derived views, then echoes the change into the SQL mirror the
 * pond reads. Writing the mirror directly from here would desync the record.
 * On success every pond query is refetched, so the dot, the line, the rail
 * counts and the open card all agree again.
 */
export function useRetagCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tag, verb }: { id: string; tag: string; verb: 'tag' | 'untag' }) =>
      api.post<{ id: string }>(`/api/cards/${verb}`, { id, tags: [tag] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pond'] }),
  });
}
