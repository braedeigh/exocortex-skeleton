/**
 * sessionFilters.test.ts — pins the colour rail's predicates (running /
 * active-within-the-hour / unread / error), that pressed filters UNION rather
 * than intersect, and that the counts on the buttons come from the same
 * predicates as the lists behind them — the "number and list can't disagree"
 * rule the rail was built on.
 */
import { describe, expect, it } from 'vitest';
import { applyFilter, cardState, filterCounts, matchesFilter } from './sessionFilters';
import type { SessionMeta } from './api';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;

const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  last_at: ago(5 * MIN),
  ...over,
});

describe('active', () => {
  it('takes a running session no matter how stale its stamp', () => {
    const s = session('a', { running: true, last_at: ago(400 * MIN) });
    expect(matchesFilter(s, undefined, 'active', NOW)).toBe(true);
  });

  it('takes an idle session used inside the hour and drops one outside it', () => {
    expect(matchesFilter(session('a', { last_at: ago(59 * MIN) }), undefined, 'active', NOW)).toBe(
      true,
    );
    expect(matchesFilter(session('b', { last_at: ago(61 * MIN) }), undefined, 'active', NOW)).toBe(
      false,
    );
  });

  it('drops a session with no usable stamp', () => {
    expect(matchesFilter(session('a', { last_at: '' }), undefined, 'active', NOW)).toBe(false);
  });
});

describe('unread', () => {
  it('is unread when activity postdates the last open', () => {
    const s = session('a', { last_at: ago(5 * MIN) });
    expect(matchesFilter(s, ago(60 * MIN), 'unread', NOW)).toBe(true);
    expect(matchesFilter(s, ago(1 * MIN), 'unread', NOW)).toBe(false);
  });

  it('stays unread while a session is waiting on her, even once opened', () => {
    const asking = session('a', { awaiting_input: 'which one?' });
    expect(matchesFilter(asking, ago(1 * MIN), 'unread', NOW)).toBe(true);

    const gated = session('b', {
      awaiting_approval: { tool: 'Bash', command: 'rm -rf x' },
    });
    expect(matchesFilter(gated, ago(1 * MIN), 'unread', NOW)).toBe(true);
  });
});

describe('error', () => {
  it('takes only a session whose last turn failed', () => {
    expect(matchesFilter(session('a', { last_error: 'exit 1' }), undefined, 'error', NOW)).toBe(
      true,
    );
    expect(matchesFilter(session('b', { last_error: '' }), undefined, 'error', NOW)).toBe(false);
    expect(matchesFilter(session('c'), undefined, 'error', NOW)).toBe(false);
  });
});

describe('counts', () => {
  // The buckets overlap on purpose — a session that replied two minutes ago is
  // both active and unread, and both buttons have to say so.
  it('counts one session under every colour it truly matches', () => {
    const s = [session('a', { last_at: ago(2 * MIN), last_error: 'boom' })];
    expect(filterCounts(s, {}, NOW)).toEqual({ running: 0, active: 1, unread: 1, error: 1 });
  });

  it('reads the opened map per session id', () => {
    const s = [session('a'), session('b')];
    expect(filterCounts(s, { a: ago(1 * MIN) }, NOW).unread).toBe(1);
  });
});

describe('applyFilter', () => {
  it('is the identity with no button down', () => {
    const s = [session('a'), session('b')];
    expect(applyFilter(s, {}, [], NOW)).toBe(s);
  });

  it('narrows to the chosen colour, keeping the order it was given', () => {
    const s = [
      session('a', { last_error: 'boom' }),
      session('b', { last_at: ago(200 * MIN) }),
      session('c', { last_error: 'bang' }),
    ];
    expect(applyFilter(s, { a: ago(0), b: ago(0), c: ago(0) }, ['error'], NOW).map((x) => x.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('unions two colours rather than intersecting them', () => {
    const opened = { a: ago(0), b: ago(0), c: ago(0) };
    const s = [
      session('a', { last_at: ago(2 * MIN) }), // active only
      session('b', { last_at: ago(200 * MIN), last_error: 'boom' }), // error only
      session('c', { last_at: ago(200 * MIN) }), // neither
    ];
    expect(applyFilter(s, opened, ['active', 'error'], NOW).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

// The whole point of cardState: a card and the rail button of the same colour
// are answering the same question, so these assertions are also assertions
// about the buttons.
describe('cardState', () => {
  const read = (id: string) => ({ [id]: ago(0) });

  it('gives a recently-used idle session the purple state, not grey', () => {
    const s = session('a', { last_at: ago(20 * MIN) });
    expect(cardState(s, ago(0), NOW)).toBe('recent');
    // ...and that is exactly what the purple button counted it as.
    expect(matchesFilter(s, ago(0), 'active', NOW)).toBe(true);
  });

  it('goes grey once it falls out of the hour', () => {
    expect(cardState(session('a', { last_at: ago(90 * MIN) }), ago(0), NOW)).toBe('rest');
  });

  it('ranks broken over busy over unread over merely recent', () => {
    const busyAndBroken = session('a', { running: true, last_error: 'boom' });
    expect(cardState(busyAndBroken, undefined, NOW)).toBe('error');

    const busyAndUnread = session('b', { running: true, last_at: ago(1 * MIN) });
    expect(cardState(busyAndUnread, ago(90 * MIN), NOW)).toBe('running');

    // Unread AND inside the hour — orange wins, because it wants something
    // from her and 'recent' doesn't.
    const unreadAndRecent = session('c', { last_at: ago(2 * MIN) });
    expect(cardState(unreadAndRecent, ago(90 * MIN), NOW)).toBe('unread');
  });

  it('keeps a session that stopped to ask orange even once opened', () => {
    const asking = session('a', { awaiting_input: 'which one?', last_at: ago(2 * MIN) });
    expect(cardState(asking, ago(0), NOW)).toBe('unread');
  });

  it('reads the opened stamp for the session it belongs to', () => {
    const s = session('a', { last_at: ago(2 * MIN) });
    expect(cardState(s, read('a').a, NOW)).toBe('recent');
    expect(cardState(s, undefined, NOW)).toBe('unread');
  });
});

describe('running', () => {
  it('takes only a session with a turn in flight', () => {
    expect(matchesFilter(session('a', { running: true }), undefined, 'running', NOW)).toBe(true);
    expect(matchesFilter(session('b', { last_at: ago(1 * MIN) }), undefined, 'running', NOW)).toBe(
      false,
    );
  });

  it('nests inside active rather than competing with it', () => {
    // A running session is counted by BOTH purple buttons — that's the whole
    // shape: "only what's actually running" sits inside "used in the hour".
    const s = session('a', { running: true, last_at: ago(400 * MIN) });
    expect(matchesFilter(s, undefined, 'running', NOW)).toBe(true);
    expect(matchesFilter(s, undefined, 'active', NOW)).toBe(true);
  });

  it('never counts more than active does', () => {
    const s = [
      session('a', { running: true }),
      session('b', { last_at: ago(5 * MIN) }),
      session('c', { last_at: ago(300 * MIN) }),
    ];
    const c = filterCounts(s, {}, NOW);
    expect(c.running).toBe(1);
    expect(c.active).toBe(2);
    expect(c.running).toBeLessThanOrEqual(c.active);
  });

  it('drives the same card state as the button', () => {
    const s = session('a', { running: true });
    expect(cardState(s, ago(0), NOW)).toBe('running');
    // ...while the merely-recent one gets the steady rung.
    expect(cardState(session('b', { last_at: ago(20 * MIN) }), ago(0), NOW)).toBe('recent');
  });
});
