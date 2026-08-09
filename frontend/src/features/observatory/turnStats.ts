/**
 * turnStats.ts — the Claude Code-style working line, ported into the reading
 * room: "✻ Percolating… 12s · ~1.3k tokens". A pure reducer over
 * the same raw SSE events events.ts sees (kept separate on purpose:
 * events.ts builds the transcript, this builds the heartbeat).
 *
 * Where the numbers come from:
 * - elapsed: wall time since the send started;
 * - tokens: the API only reports authoritative usage ONCE per message (the
 *   closing message_delta), so mid-stream the count is an estimate from
 *   streamed characters (~4 chars/token, shown with a "~"); each message's
 *   estimate snaps to the real number when its usage arrives, and finished
 *   messages are banked across tool round-trips on message_start;
 * - thought: wall time accumulated while thinking deltas are arriving
 *   (gaps over THINKING_GAP_MS don't count — that's tool time, not thought).
 *   Measured but NOT shown — see formatWorkingLine.
 */

export interface TurnStats {
  word: string;
  startedAt: number;
  /** Output tokens from messages already finished this turn (authoritative
   * when their usage arrived, else their final estimate). */
  doneTokens: number;
  /** The in-flight message's authoritative usage — null until its closing
   * message_delta lands. */
  liveUsage: number | null;
  /** Streamed characters (text + thinking) of the in-flight message — the
   * estimate basis while liveUsage is null. */
  liveChars: number;
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

const THINKING_GAP_MS = 3000;
const CHARS_PER_TOKEN = 4;

export function startTurnStats(now: number, word?: string): TurnStats {
  return {
    word: word ?? WORKING_WORDS[Math.floor(Math.random() * WORKING_WORDS.length)],
    startedAt: now,
    doneTokens: 0,
    liveUsage: null,
    liveChars: 0,
    thinkingMs: 0,
    lastThinkingAt: null,
  };
}

interface StreamEventShape {
  type?: string;
  message?: { usage?: { output_tokens?: number } };
  usage?: { output_tokens?: number };
  delta?: { type?: string; text?: string; thinking?: string };
}

function liveTokens(s: TurnStats): number {
  return s.liveUsage ?? Math.round(s.liveChars / CHARS_PER_TOKEN);
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
    // A new message begins — bank the finished one and reset the live basis.
    next.doneTokens += liveTokens(next);
    next.liveChars = 0;
    next.liveUsage = ev.message?.usage?.output_tokens ?? null;
  } else if (ev.type === 'message_delta') {
    const tokens = ev.usage?.output_tokens;
    if (typeof tokens === 'number') next.liveUsage = tokens;
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    const chunk = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : undefined;
    if (typeof chunk === 'string') next.liveChars += chunk.length;
    if (d?.type === 'thinking_delta') {
      if (next.lastThinkingAt !== null && now - next.lastThinkingAt < THINKING_GAP_MS) {
        next.thinkingMs += now - next.lastThinkingAt;
      }
      next.lastThinkingAt = now;
    }
  }
  return next;
}

export function totalTokens(stats: TurnStats): number {
  return stats.doneTokens + liveTokens(stats);
}

/** True while the in-flight message's count is a character estimate. */
export function tokensAreEstimated(stats: TurnStats): boolean {
  return stats.liveUsage === null && stats.liveChars > 0;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/**
 * A session's lifetime spend, for the roster card and the session header:
 * "18.2k tokens · $4.21". Same 1-decimal-k shape as the working line above so
 * the running total and the in-flight count read as the same kind of number,
 * and millions fold to "m" rather than printing "1832.4k".
 *
 * The cost is dropped below a cent — a session that has barely started should
 * say what it wrote, not claim "$0.00".
 */
export function formatSessionSpend(tokens: { output: number; cost_usd: number }): string {
  const n = tokens.output;
  const count =
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m tokens` : fmtTokens(n);
  return tokens.cost_usd >= 0.01 ? `${count} · $${tokens.cost_usd.toFixed(2)}` : count;
}

/**
 * "Percolating… 12s · ~1.3k tokens" — parts appear as their numbers do; the
 * "~" drops once the API's own count lands.
 *
 * ONE clock on this line, deliberately. It used to end with "· thought 4s",
 * and a second bare Ns beside a running one reads as a rival clock that keeps
 * losing: thinking time only advances while thinking deltas are arriving, so
 * it stalls whenever the elapsed count doesn't ("it says x seconds twice, the
 * second one is laggier"). It was never the same kind of number. `thinkingMs`
 * is still measured on TurnStats below — nothing renders it, so bringing it
 * back in some shape that can't be mistaken for a clock is a one-liner.
 */
export function formatWorkingLine(stats: TurnStats, now: number): string {
  const secs = Math.max(0, Math.floor((now - stats.startedAt) / 1000));
  const parts = [`${stats.word}… ${secs}s`];
  const tokens = totalTokens(stats);
  if (tokens > 0) parts.push(`${tokensAreEstimated(stats) ? '~' : ''}${fmtTokens(tokens)}`);
  return parts.join(' · ');
}
