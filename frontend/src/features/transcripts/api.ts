/**
 * api.ts — the transcript organizer's reads and writes (routes/transcripts.py).
 *
 * Reads: the overview (counts, topics, the sorter's progress, sign-in state),
 * the pond cards, and one conversation in full when it's opened. Writes: an
 * export upload, and starting a sort.
 *
 * The overview polls every few seconds ONLY while a sort is running — that's
 * the one time something changes without the user doing it — and when a
 * sort finishes the pond is refetched so the new topics light up.
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../api/client';
import type { PondCard } from '../terrain/pond/pondMath';

export interface TranscriptTopic {
  id: number;
  name: string;
  /** The tag its messages carry on the pond — "t<id>". */
  tag: string;
  days: number;
  first: string | null;
  last: string | null;
  /** Every conversation filed under it — the topic's links back to its sources. */
  conversations: { id: number; title: string }[];
}

export interface SortStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  running: boolean;
  done?: number;
  total?: number;
  error?: string;
}

export interface TranscriptOverview {
  stats: { conversations: number; messages: number; unsorted: number };
  topics: TranscriptTopic[];
  sort: SortStatus;
  llm: { provider: string; signed_in: boolean; detail: string };
}

/** A pond card plus the conversation it came from. `kind` is the source. */
export interface TranscriptCard extends PondCard {
  conv: number;
}

export interface TranscriptMessage {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  ts: string | null;
}

export interface TranscriptConversation {
  id: number;
  source: string;
  title: string;
  summary: string;
  topics: { id: number; name: string; tag: string }[];
  messages: TranscriptMessage[];
}

const OVERVIEW_KEY = ['transcripts', 'overview'];
const POLL_MS = 3000;

export function useTranscriptOverview() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api.get<TranscriptOverview>('/api/transcripts/overview'),
    refetchInterval: (q) => (q.state.data?.sort.running ? POLL_MS : false),
  });
  // When a running sort stops, the pond's tags are stale — refetch them.
  const wasRunning = useRef(false);
  const running = query.data?.sort.running ?? false;
  useEffect(() => {
    if (wasRunning.current && !running) {
      void client.invalidateQueries({ queryKey: ['transcripts', 'pond'] });
    }
    wasRunning.current = running;
  }, [running, client]);
  return query;
}

export function useTranscriptPond(from: string | null, q: string) {
  return useQuery({
    queryKey: ['transcripts', 'pond', from, q],
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (q) params.set('q', q);
      return api.get<{ cards: TranscriptCard[]; truncated: boolean }>(
        `/api/transcripts/pond?${params.toString()}`,
      );
    },
    placeholderData: (previous) => previous,
  });
}

export function useConversation(id: number | null) {
  return useQuery({
    queryKey: ['transcripts', 'conversation', id],
    queryFn: () => api.get<TranscriptConversation>(`/api/transcripts/conversation/${id}`),
    enabled: id !== null,
  });
}

/** Upload an export (multipart — a file can't ride in JSON). Mirrors
 * recordings/api.ts's postForm: same-origin, credentials, {error} → ApiError. */
async function uploadExport(file: File) {
  const form = new FormData();
  form.append('export', file);
  const res = await fetch('/api/transcripts/import', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (res.status === 413) throw new ApiError(413, 'That file is too large to upload here.');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as { read: number; added: number; updated: number; unchanged: number };
}

export function useImportExport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: uploadExport,
    onSuccess: () => client.invalidateQueries({ queryKey: ['transcripts'] }),
  });
}

export function useStartSort() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ started: boolean }>('/api/transcripts/sort', {}),
    onSuccess: () => client.invalidateQueries({ queryKey: OVERVIEW_KEY }),
  });
}
