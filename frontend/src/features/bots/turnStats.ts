/**
 * turnStats.ts — the Claude Code-style working line, ported into the reading
 * room: "✻ Percolating… 12s · 1.3k tokens · thought 4s". A pure reducer over
 * the same raw SSE events botEvents.ts sees (kept separate on purpose:
 * botEvents builds the transcript, this builds the heartbeat).
 *
 * Where the numbers come from:
 * - elapsed: wall time since the send started;
 * - tokens: the API's own count — message_delta stream events carry a
 *   cumulative usage.output_tokens for the in-flight message, and a turn can
 *   hold several messages (tool round-trips), so finished messages are banked
 *   on each message_start;
 * - thought: wall time accumulated while thinking deltas are arriving
 *   (gaps over _THINKING_GAP_MS don't count — that's tool time, not thought).
 */

export interface TurnStats {
  word: string;
  startedAt: number;
  /** Output tokens from messages already finished this turn. */
  doneTokens: number;
  /** Cumulative output tokens of the in-flight message (from message_delta). */
  liveTokens: number;
  thinkingMs: number;
  lastThinkingAt: number | null;
}

/** The spinner's vocabulary — one word picked per turn, Claude Code style. */
export const WORKING_WORDS = [
  'Pondering',
  'Percolating',
  'Conjuring',
  'Musing',
  'Brewing',
  'Noodling',
  'Weaving',
  'Simmering',
  'Mulling',
  'Divining',
  'Untangling',
  'Kindling',
  'Burrowing',
  'Composing',
  'Sifting',
  'Tinkering',
];

const _THINKING_GAP_MS = 3000;

export function startTurnStats(now: number, word?: string): TurnStats {
  return {
    word: word ?? WORKING_WORDS[Math.floor(Math.random() * WORKING_WORDS.length)],
    startedAt: now,
    doneTokens: 0,
    liveTokens: 0,
    thinkingMs: 0,
    lastThinkingAt: null,
  };
}

interface StreamEventShape {
  type?: string;
  message?: { usage?: { output_tokens?: number } };
  usage?: { output_tokens?: number };
  delta?: { type?: string };
}

/** Fold one raw SSE event into the stats. Returns a new object (safe to hand
 * straight to setState); non-stream events pass through untouched. */
export function applyStatsEvent(
  stats: TurnStats,
  raw: Record<string, unknown>,
  now: number,
): TurnStats {
  if (raw.type !== 'stream_event') return stats;
  const ev = raw.event as StreamEventShape | undefined;
  if (!ev || typeof ev !== 'object') return stats;
  const next = { ...stats };
  if (ev.type === 'message_start') {
    // A new message begins — bank the finished one (usage is per-message).
    next.doneTokens += next.liveTokens;
    next.liveTokens = ev.message?.usage?.output_tokens ?? 0;
  } else if (ev.type === 'message_delta') {
    const tokens = ev.usage?.output_tokens;
    if (typeof tokens === 'number') next.liveTokens = tokens;
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
    if (next.lastThinkingAt !== null && now - next.lastThinkingAt < _THINKING_GAP_MS) {
      next.thinkingMs += now - next.lastThinkingAt;
    }
    next.lastThinkingAt = now;
  }
  return next;
}

export function totalTokens(stats: TurnStats): number {
  return stats.doneTokens + stats.liveTokens;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** "Percolating… 12s · 1.3k tokens · thought 4s" — parts appear as their
 * numbers do, so the line starts as just the word and the clock. */
export function formatWorkingLine(stats: TurnStats, now: number): string {
  const secs = Math.max(0, Math.round((now - stats.startedAt) / 1000));
  const parts = [`${stats.word}… ${secs}s`];
  const tokens = totalTokens(stats);
  if (tokens > 0) parts.push(fmtTokens(tokens));
  const thoughtSecs = Math.round(stats.thinkingMs / 1000);
  if (thoughtSecs > 0) parts.push(`thought ${thoughtSecs}s`);
  return parts.join(' · ');
}
