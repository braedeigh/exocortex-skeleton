/**
 * tokenBurn.ts — the Token burn page's data: what the server sends, how to
 * ask for it, and how its numbers are written on the page.
 *
 * The server (routes/token_burn.py) adds up every Observatory turn's own
 * tokens and estimated cost from exo.db's turn_usage table. This file only
 * asks for it and formats it; nothing here computes a total, so the page can
 * never disagree with the route test that proves the totals add up.
 *
 * Touches: api/client (the fetch), TokenBurnPage.tsx (the only reader).
 *
 * Prompt that produced this: "Like could you make me one of these" (a TOKEN
 * BURN dashboard screenshot), and later "I want to measure everything as
 * accurately as possible and understand how many tokens are used and when."
 */
import { api } from '../../api/client';

export type BurnGroup = 'model' | 'session' | 'room' | 'kind';
export type BurnRange = '24h' | '7d' | '30d' | 'all';

export const GROUPS: { key: BurnGroup; label: string }[] = [
  { key: 'model', label: 'by model' },
  { key: 'session', label: 'by session' },
  { key: 'room', label: 'by room' },
  { key: 'kind', label: 'by kind' },
];

export const RANGES: { key: BurnRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'all' },
];

/** The four kinds of token, in the order a call spends them. */
export type TokenKind = 'input' | 'cache_write' | 'cache_read' | 'output';

export const KIND_LABEL: Record<TokenKind, string> = {
  cache_read: 'Re-read from cache',
  cache_write: 'Newly cached',
  input: 'Fresh input',
  output: 'Written',
};

export interface BurnRow {
  key: string;
  label: string;
  tokens: number;
  cost_usd: number;
  /** null on the by-kind rows, where every turn spends every kind. */
  turns: number | null;
  sessions: number;
  share: number;
  /** by-session rows only */
  conv?: string;
  room?: string;
}

export interface BurnTotals extends Record<TokenKind, number> {
  tokens: number;
  cost_usd: number;
  turns: number;
  sessions: number;
  thinking: number;
  kind_cost_usd: Record<TokenKind, number>;
}

export interface BurnBucket extends Record<TokenKind, number> {
  /** "2026-09-30T15" (an hour) or "2026-09-30" (a day), local time. */
  bucket: string;
  cost_usd: number;
  turns: number;
}

export interface BurnState {
  group: BurnGroup;
  range: BurnRange;
  since: string | null;
  totals: BurnTotals;
  rows: BurnRow[];
  timeline: BurnBucket[];
  outside: { calls: number; sessions: number; context_tokens: number };
  freshness: { updated_at: string | null; latest_turn_at: string | null; waiting: number; stale: boolean };
  coverage: { first_day: string | null; undated_turns: number };
}

export interface BurnCall extends Record<TokenKind, number | null> {
  at: string;
  model: string | null;
  subagent: number;
  tools: string | null;
}

export interface BurnTurn {
  seq: number | null;
  at: string | null;
  subtype: string | null;
  duration_ms?: number | null;
  models?: string | null;
  input?: number | null;
  cache_write?: number | null;
  cache_read?: number | null;
  output?: number | null;
  cost_usd?: number | null;
  calls: BurnCall[];
}

export interface BurnSession {
  conv: string;
  title: string;
  room: string;
  turns: BurnTurn[];
}

export function getBurn(group: BurnGroup, range: BurnRange, signal?: AbortSignal): Promise<BurnState> {
  return api.get(`/api/token-burn?group=${group}&range=${range}`, signal);
}

export function getBurnSession(conv: string, signal?: AbortSignal): Promise<BurnSession> {
  return api.get(`/api/token-burn/session/${encodeURIComponent(conv)}`, signal);
}

/** A token count, short: 812, 4.1k, 112.5M, 4.39B. */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e11 ? 0 : 2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** An estimated cost, short: $0.20, $41, $1.9k. */
export function fmtCost(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/** A share of the whole, as the table's percent column writes it. */
export function fmtShare(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/** Minutes since a local ISO stamp, or null. */
export function minutesSince(stamp: string | null, nowMs: number = Date.now()): number | null {
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 60000));
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function fmtAgo(minutes: number | null): string {
  if (minutes == null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
