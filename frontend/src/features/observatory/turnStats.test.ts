/**
 * turnStats — the working line's arithmetic: estimate-then-snap token
 * counting (the API reports usage once per message, at the end), banking
 * across messages, thinking-time accumulation with the tool-gap cutoff, and
 * the formatted line growing parts as numbers arrive.
 */
import { describe, expect, it } from 'vitest';
import {
  applyStatsEvent,
  formatWorkingLine,
  startTurnStats,
  tokensAreEstimated,
  totalTokens,
} from './turnStats';

const t0 = 1_000_000;

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'stream_event', event };
}

const textDelta = (text: string) =>
  streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

describe('token counting', () => {
  it('estimates from streamed characters while usage has not arrived (~4 chars/token)', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, textDelta('x'.repeat(80)), t0);
    expect(totalTokens(s)).toBe(20);
    expect(tokensAreEstimated(s)).toBe(true);
  });

  it('snaps to the authoritative count when the closing message_delta lands', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, textDelta('x'.repeat(80)), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 33 } }), t0);
    expect(totalTokens(s)).toBe(33);
    expect(tokensAreEstimated(s)).toBe(false);
  });

  it('banks finished messages when the next one starts (tool round-trips)', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 90 } }), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_start', message: { usage: { output_tokens: 5 } } }), t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 30 } }), t0);
    expect(totalTokens(s)).toBe(120);
  });

  it('a new message resets the character estimate basis', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, textDelta('x'.repeat(40)), t0); // ~10
    s = applyStatsEvent(s, streamEvent({ type: 'message_start', message: {} }), t0);
    s = applyStatsEvent(s, textDelta('x'.repeat(8)), t0); // ~2
    expect(totalTokens(s)).toBe(12); // 10 banked + 2 live, not 12+10
  });

  it('ignores non-stream events and malformed frames', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, { type: 'assistant', message: {} }, t0);
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta' }), t0);
    expect(totalTokens(s)).toBe(0);
  });
});

describe('thinking time', () => {
  const think = streamEvent({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'hmm' },
  });

  it('accumulates wall time while thinking deltas keep arriving', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 1000);
    s = applyStatsEvent(s, think, t0 + 2000);
    expect(s.thinkingMs).toBe(2000);
  });

  it('does not count gaps over the cutoff — that is tool time, not thought', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 10_000); // long silence between thoughts
    s = applyStatsEvent(s, think, t0 + 10_500);
    expect(s.thinkingMs).toBe(500);
  });

  it('thinking characters count toward the token estimate too', () => {
    let s = startTurnStats(t0, 'Pondering');
    s = applyStatsEvent(s, think, t0); // 'hmm' = 3 chars
    expect(s.liveChars).toBe(3);
  });
});

describe('the formatted line', () => {
  it('starts as just the word and the clock', () => {
    const s = startTurnStats(t0, 'Percolating');
    expect(formatWorkingLine(s, t0 + 3000)).toBe('Percolating… 3s');
  });

  it('marks estimates with ~ and drops it once usage lands', () => {
    let s = startTurnStats(t0, 'Musing');
    s = applyStatsEvent(s, textDelta('x'.repeat(168)), t0);
    expect(formatWorkingLine(s, t0 + 1000)).toBe('Musing… 1s · ~42 tokens');
    s = applyStatsEvent(s, streamEvent({ type: 'message_delta', usage: { output_tokens: 1337 } }), t0);
    expect(formatWorkingLine(s, t0 + 12_000)).toBe('Musing… 12s · 1.3k tokens');
  });

  // Thinking time is still measured (the gap rule below is the thing worth
  // protecting), but the line shows one clock and one clock only — a second
  // Ns beside a running one read as a laggy duplicate of it.
  it('keeps thought time off the line, however much accumulates', () => {
    const think = streamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: '' },
    });
    let s = startTurnStats(t0, 'Sifting');
    s = applyStatsEvent(s, think, t0);
    s = applyStatsEvent(s, think, t0 + 4000); // over the gap: not counted
    s = applyStatsEvent(s, think, t0 + 5000);
    expect(s.thinkingMs).toBe(1000);
    expect(formatWorkingLine(s, t0 + 6000)).toBe('Sifting… 6s');
  });
});
