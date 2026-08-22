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
import type { PondCard, PondWorking } from './pondMath';
import type { ShapeDay } from './pondShape';

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

/** The pond drawn small: its per-day profile and nothing else. */
export interface PondShapePayload {
  days: ShapeDay[];
  /** Every card in the window — the landmark's one number. */
  cards: number;
  from: string | null;
  to: string | null;
}

export interface PondCardDetail extends PondCard {
  body: string;
  reply_to: string | null;
  session: string | null;
  refs: string | null;
  first_seen: string;
  last_seen: string;
}

/** Both reads take the same optional window start (`from`, YYYY-MM-DD, null =
 * as far back as the pool goes) so the rail and the drawing always describe
 * the same slice of time — a thread ranked by days it touched in a window the
 * cards don't share would be quietly wrong. */
export function usePondThreads(from: string | null) {
  return useQuery({
    queryKey: ['pond', 'threads', from],
    queryFn: () =>
      api.get<{ threads: PondThread[]; fronts: PondFront[] }>(
        `/api/pond/threads${from ? `?from=${from}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

/** Every card in the window. Not filtered by the lit thread: lighting one is a
 * change of emphasis, not of subject — the rest of the pond stays visible
 * around it, which is the whole point of seeing a thread in context. */
export function usePondCards(from: string | null) {
  return useQuery({
    queryKey: ['pond', 'cards', from],
    queryFn: () =>
      api.get<PondCardsPayload>(`/api/pond/cards${from ? `?from=${from}` : ''}`),
    staleTime: 60_000,
  });
}

/**
 * The working half of her days — messages to agents, files written, sessions
 * sitting open.
 *
 * Its own query, not folded into the cards one, for the same reason the card
 * detail is separate: it's roughly three times the size of the card list, and
 * it's only worth fetching for the arrangement that can draw it. Kept fresh a
 * little harder than the journal (30s rather than 60s) because a session she
 * is IN RIGHT NOW is the case where the answer changes while she's looking.
 */
export function usePondWorking(from: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['pond', 'working', from],
    queryFn: () =>
      api.get<PondWorking & { truncated: boolean }>(
        `/api/pond/working${from ? `?from=${from}` : ''}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * The pond's silhouette — one row per day, nothing else.
 *
 * What the landmark on the terrain map draws itself from. Kept separate from
 * `usePondCards` because the map has no business pulling several hundred
 * kilobytes of card bodies to draw a thumbnail: this payload is a couple of
 * hundred small rows and the server does the counting.
 *
 * A long staleTime because a silhouette doesn't meaningfully change within a
 * session — a card or two added today moves one column by a pixel.
 */
export function usePondShape(enabled = true) {
  return useQuery({
    queryKey: ['pond', 'shape'],
    queryFn: () => api.get<PondShapePayload>('/api/pond/shape'),
    enabled,
    staleTime: 5 * 60_000,
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
