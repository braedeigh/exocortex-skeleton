/**
 * turnStats — the working line's arithmetic: token banking across messages,
 * thinking-time accumulation with the tool-gap cutoff, and the formatted
 * line growing parts as numbers arrive.
 */
import { describe, expect, it } from 'vitest';
import {
  applyStatsEvent,
  formatWorkingLine,
  startTurnStats,
  totalTokens,
} from './turnStats';

const t0 = 1_000_000;

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'stream_event', event };
}

describe('token counting', () => {
  it('tracks the cumulative usage of the in-flight message', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 40 } }), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 90 } }), t0);
    // Cumulative, not additive: 90, not 130.
    expect(totalTokens(s)).toBe(90);
  });

  it('banks finished messages when the next one starts (tool round-trips)', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 90 } }), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_start', message: { usage: { output_tokens: 5 } } }), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 30 } }), t0);
    expect(totalTokens(s)).toBe(120);
  });

  it('ignores non-stream events and malformed frames', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, { type: 'assistant', message: {} }, t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta' }), t0);
    expect(totalTokens(s)).toBe(0);
  });
});

describe('thinking time', () => {
  it('accumulates wall time while thinking deltas keep arriving', () => {
    const think = streamEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta' } });
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 1000);
    s = applyStatsEvent(s, think, t0 + 2000);
    expect(s.thinkingMs).toBe(2000);
  });

  it('does not count gaps over the cutoff — that is tool time, not thought', () => {
    const think = streamEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta' } });
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 10_000); // long silence between thoughts
    s = applyStatsEvent(s, think, t0 + 10_500);
    expect(s.thinkingMs).toBe(500);
  });
});

describe('the formatted line', () => {
  it('starts as just the word and the clock', () => {
    const s = startTurnStats(t0, 'Percolating');
    expect(formatWorkingLine(s, t0 + 3000)).toBe('Percolating… 3s');
  });

  it('grows token and thought parts as their numbers arrive', () => {
    let s = startTurnStats(t0, 'Musing');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 1337 } }), t0);
    const think = streamEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta' } });
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 2000);
    s = applyStatsEvent(s, think, t0 + 4000);
    expect(formatWorkingLine(s, t0 + 12_000)).toBe('Musing… 12s · 1.3k tokens · thought 4s');
  });

  it('keeps small token counts unabbreviated', () => {
    let s = startTurnStats(t0, 'Sifting');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 42 } }), t0);
    expect(formatWorkingLine(s, t0 + 1000)).toBe('Sifting… 1s · 42 tokens');
  });
});
