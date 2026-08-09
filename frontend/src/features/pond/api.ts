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
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PondCard } from './pondMath';

export interface PondThread {
  tag: string;
  /** How many cards carry the tag. */
  cards: number;
  /** How many distinct DAYS it touches — what the list is ranked by. */
  days: number;
  first: string;
  last: string;
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
    queryFn: () => api.get<{ threads: PondThread[] }>('/api/pond/threads'),
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
