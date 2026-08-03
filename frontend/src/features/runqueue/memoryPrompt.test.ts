import { describe, expect, it } from 'vitest';
import { barSegments, promptActions, promptReason, queueSummary, shouldPrompt } from './memoryPrompt';
import type { Headroom } from './memoryPrompt';

function h(over: Partial<Headroom> = {}): Headroom {
  return {
    available_mb: 2000,
    total_mb: 3819,
    floor_mb: 1024,
    per_run_mb: 450,
    cap: 3,
    running: 0,
    queued: 0,
    would_admit: true,
    paused_until: null,
    pause_reason: null,
    ...over,
  };
}

describe('shouldPrompt', () => {
  it('stays quiet when there is room', () => {
    expect(shouldPrompt(h())).toBe(false);
  });

  it('asks once the background runs hit their cap', () => {
    expect(shouldPrompt(h({ running: 3 }))).toBe(true);
  });

  it('asks when there is no headroom for one more', () => {
    expect(shouldPrompt(h({ would_admit: false }))).toBe(true);
  });

  it('asks while the queue is paused on a usage limit', () => {
    expect(shouldPrompt(h({ paused_until: '2026-08-03T17:00:00' }))).toBe(true);
  });

  it('does not nag when the memory simply cannot be read', () => {
    expect(shouldPrompt(h({ available_mb: null, would_admit: false }))).toBe(false);
  });

  it('does not nag without any headroom data at all', () => {
    expect(shouldPrompt(null)).toBe(false);
  });
});

describe('promptActions', () => {
  it('offers starting anyway when we asked first', () => {
    expect(promptActions(h({ running: 3 }), false)).toEqual(['start', 'queue', 'cancel']);
  });

  it('never offers a button that can only fail', () => {
    // The server already refused this send — "Start anyway" would 503 again.
    expect(promptActions(h({ would_admit: false }), true)).toEqual(['queue', 'cancel']);
  });

  it('withholds start when the box is genuinely out of memory', () => {
    // Under the cap, so it's memory that's short — the send would 503.
    expect(promptActions(h({ would_admit: false, running: 1, available_mb: 900 }), false)).toEqual([
      'queue',
      'cancel',
    ]);
  });

  it('still offers start at the cap, because the cap is a soft stop', () => {
    // The server doesn't enforce the concurrency cap on her own sessions.
    expect(promptActions(h({ running: 3, would_admit: false }), false)).toContain('start');
  });
});

describe('promptReason', () => {
  it('names the cap when that is what stopped us', () => {
    expect(promptReason(h({ running: 3 }), false)).toContain('3 background runs');
  });

  it('names the free memory when the server refused', () => {
    expect(promptReason(h({ available_mb: 612 }), true)).toContain('612MB');
  });

  it('explains a pause in plain words', () => {
    const reason = promptReason(
      h({ paused_until: '2026-08-03T17:00:00', pause_reason: 'a run hit the usage limit' }),
      false,
    );
    expect(reason).toContain('a run hit the usage limit');
  });

  it('says something useful even with nothing to go on', () => {
    expect(promptReason(null, false).length).toBeGreaterThan(0);
  });
});

describe('barSegments', () => {
  it('splits the box into used, reserved and free', () => {
    const seg = barSegments(h({ total_mb: 4000, available_mb: 2000, floor_mb: 1000 }))!;
    expect(seg.used).toBe(50); // 4000 - 2000
    expect(seg.reserved).toBe(25); // the floor, kept for the site
    expect(seg.free).toBe(25); // what a new session could actually have
  });

  it('never reserves more than is actually free', () => {
    const seg = barSegments(h({ total_mb: 4000, available_mb: 500, floor_mb: 1024 }))!;
    expect(seg.reserved).toBe(12.5);
    expect(seg.free).toBe(0);
  });

  it('draws no bar rather than a made-up one when memory is unreadable', () => {
    expect(barSegments(h({ available_mb: null }))).toBeNull();
    expect(barSegments(h({ total_mb: null }))).toBeNull();
  });
});

describe('queueSummary', () => {
  it('mentions waiting work only when there is some', () => {
    expect(queueSummary(h({ running: 2 }))).toBe('2 running');
    expect(queueSummary(h({ running: 2, queued: 5 }))).toBe('2 running · 5 waiting');
  });
});
