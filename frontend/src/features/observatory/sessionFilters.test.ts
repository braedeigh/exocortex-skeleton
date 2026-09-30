/**
 * sessionFilters.test.ts — pins the colour rail's predicates (running /
 * active-within-the-hour / unread / error), that pressed filters UNION rather
 * than intersect, and that the counts on the buttons come from the same
 * predicates as the lists behind them — the "number and list can't disagree"
 * rule the rail was built on.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_FILTERS,
  applyFilter,
  cardState,
  filterCounts,
  matchesFilter,
  roomRoster,
  sessionIs,
} from './sessionFilters';
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
    // Opened AFTER the activity in both cases — an unopened one would be
    // unread, and unread is orange, not purple.
    expect(matchesFilter(session('a', { last_at: ago(59 * MIN) }), ago(0), 'active', NOW)).toBe(
      true,
    );
    expect(matchesFilter(session('b', { last_at: ago(61 * MIN) }), ago(0), 'active', NOW)).toBe(
      false,
    );
  });

  it('drops a session with no usable stamp', () => {
    expect(matchesFilter(session('a', { last_at: '' }), ago(0), 'active', NOW)).toBe(false);
  });

  it('leaves a recent-but-unread session to the orange button', () => {
    // The trade this rule makes. It's honestly both, but it can only WEAR one
    // colour, and orange is the one it wears — so purple doesn't claim it.
    const s = session('a', { last_at: ago(5 * MIN) });
    expect(cardState(s, undefined, NOW)).toBe('unread');
    expect(matchesFilter(s, undefined, 'unread', NOW)).toBe(true);
    expect(matchesFilter(s, undefined, 'active', NOW)).toBe(false);
    // ...and pressing both still reaches it, because filters union.
    expect(applyFilter([s], {}, ['active', 'unread'], NOW)).toHaveLength(1);
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

  it('reads a done session by its final output, not later housekeeping', () => {
    // Marked done 30 min ago; a peer's FYI woke it 5 min ago.
    const done = session('a', { done_at: ago(31 * MIN), final_at: ago(30 * MIN), last_at: ago(5 * MIN) });
    expect(sessionIs(done, ago(20 * MIN), 'unread', NOW)).toBe(false);
    expect(sessionIs(done, ago(40 * MIN), 'unread', NOW)).toBe(true);
    expect(sessionIs(done, undefined, 'unread', NOW)).toBe(true);
  });

  it('reads a retired session by its handoff', () => {
    const retired = session('a', { retired: true, retired_at: ago(30 * MIN), last_at: ago(5 * MIN) });
    expect(sessionIs(retired, ago(20 * MIN), 'unread', NOW)).toBe(false);
    expect(sessionIs(retired, ago(40 * MIN), 'unread', NOW)).toBe(true);
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
  // A number on a button is how many cards she can SEE wearing that colour, so
  // a session counts once, under the colour it actually wears. This one is
  // broken, and broken outranks everything.
  it('counts a session under the one colour it wears', () => {
    const s = [session('a', { last_at: ago(2 * MIN), last_error: 'boom' })];
    expect(filterCounts(s, {}, NOW)).toEqual({ running: 0, active: 0, unread: 0, error: 1 });
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

    // Unread AND inside the hour — unread wins (a grey card with an orange
    // dot), because it wants something from her and 'recent' doesn't.
    const unreadAndRecent = session('c', { last_at: ago(2 * MIN) });
    expect(cardState(unreadAndRecent, ago(90 * MIN), NOW)).toBe('unread');
  });

  it('keeps a session that stopped to ask orange even once opened', () => {
    const asking = session('a', { awaiting_input: 'which one?', last_at: ago(2 * MIN) });
    expect(cardState(asking, ago(0), NOW)).toBe('asking');
  });

  it('keeps orange for asking — a reply merely unread is its own quieter state', () => {
    const gated = session('a', { awaiting_approval: { command: 'rm -rf x' } as SessionMeta['awaiting_approval'] });
    expect(cardState(gated, undefined, NOW)).toBe('asking');
    expect(cardState(session('b'), undefined, NOW)).toBe('unread');
  });

  it('lets the orange button return both the asking cards and the unread ones', () => {
    const asking = session('a', { awaiting_input: 'which?' });
    const unread = session('b');
    expect(applyFilter([asking, unread], {}, ['unread'], NOW)).toHaveLength(2);
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
    // Both read, so neither is orange — running and recent are the two halves
    // of purple, and Running is the inner one.
    const s = [
      session('a', { running: true }),
      session('b', { last_at: ago(5 * MIN) }),
      session('c', { last_at: ago(300 * MIN) }),
    ];
    const c = filterCounts(s, { a: ago(0), b: ago(0), c: ago(0) }, NOW);
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

/** The contract the whole rail rests on: press a colour, get that colour. */
describe('a button returns only cards wearing its colour', () => {
  it('orange does not hand back the purple card underneath it', () => {
    // Her 08-21 report, exactly: a running session she hasn't opened. It IS
    // unread as a fact, and its card paints purple because running outranks
    // unread — so the orange button used to return a purple card.
    const runningUnread = session('a', { running: true, last_at: ago(1 * MIN) });
    expect(sessionIs(runningUnread, undefined, 'unread', NOW)).toBe(true);
    expect(cardState(runningUnread, undefined, NOW)).toBe('running');
    expect(matchesFilter(runningUnread, undefined, 'unread', NOW)).toBe(false);
    expect(applyFilter([runningUnread], {}, ['unread'], NOW)).toEqual([]);
  });

  it('every pressed colour returns cards of only that colour', () => {
    const roster = [
      session('broken', { last_error: 'boom' }),
      session('live', { running: true }),
      session('unopened', { last_at: ago(2 * MIN) }),
      session('warm', { last_at: ago(20 * MIN) }),
      session('cold', { last_at: ago(600 * MIN) }),
    ];
    const opened = { live: ago(0), warm: ago(0), cold: ago(0) };

    for (const f of ALL_FILTERS) {
      const got = applyFilter(roster, opened, [f], NOW);
      // The list is exactly what the button's face promised...
      expect(got).toHaveLength(filterCounts(roster, opened, NOW)[f]);
      // ...and every card in it wears a colour that button means.
      for (const s of got) {
        const paint = cardState(s, opened[s.id as keyof typeof opened], NOW);
        expect(f === 'active' ? ['running', 'recent'] : [f]).toContain(paint);
      }
    }
  });

  it('keeps Running nested inside Active — they are one colour', () => {
    const live = session('a', { running: true });
    expect(matchesFilter(live, ago(0), 'running', NOW)).toBe(true);
    expect(matchesFilter(live, ago(0), 'active', NOW)).toBe(true);
    // ...while the steady half of purple is Active only.
    const warm = session('b', { last_at: ago(20 * MIN) });
    expect(matchesFilter(warm, ago(0), 'running', NOW)).toBe(false);
    expect(matchesFilter(warm, ago(0), 'active', NOW)).toBe(true);
  });
});

/** The population the rail counts. The predicates above were always right; what
 * broke was feeding them the raw payload, which carries sessions no room on the
 * page draws. */
describe('roomRoster', () => {
  it('keeps a retired session off the front page while it wears orange', () => {
    const asking = session('asking', { retired: true, awaiting_input: 'q' });
    const unread = session('unread', { retired: true });
    const quiet = session('quiet', { retired: true });
    const opened = { quiet: ago(0) };
    expect(roomRoster([asking, unread, quiet], opened, NOW).map((s) => s.id)).toEqual(['quiet']);
  });

  it('drops the pinned Keeper and every night-crew worker', () => {
    const kept = roomRoster([
      session('keeper', { pinned: true }),
      session('worker', { origin: 'nightcrew' }),
      session('mine'),
    ]);
    expect(kept.map((s) => s.id)).toEqual(['mine']);
  });

  it('leaves a saved-for-later session out of the rooms and the orange count', () => {
    const rooms = roomRoster(
      [session('parked', { saved_at: ago(0), awaiting_input: 'q' }), session('mine')],
      {},
      NOW,
    );
    expect(rooms.map((s) => s.id)).toEqual(['mine']);
    expect(filterCounts(rooms, { mine: ago(0) }, NOW).unread).toBe(0);
  });

  it('keeps a session whose lane no longer has a room', () => {
    // Retired-lane sessions still get drawn (they fall through to Coding), so
    // they have to stay countable or the rail under-reports instead of over-.
    const kept = roomRoster([session('orphan', { lane: 'orchestra' })]);
    expect(kept.map((s) => s.id)).toEqual(['orphan']);
  });

  it('counts only what the rooms draw — the 32-unread / 3-error bug', () => {
    // Her install, in miniature: one visible session, a pinned Keeper, and a
    // pile of night-crew workers, three of which failed. Counting the raw
    // payload claimed errors that lived in no room she could open, and unread
    // sessions she had no card for.
    const payload: SessionMeta[] = [
      session('mine', { last_at: ago(5 * MIN) }),
      session('keeper', { pinned: true }),
      ...Array.from({ length: 6 }, (_, i) =>
        session(`worker${i}`, { origin: 'nightcrew', last_error: i < 3 ? 'boom' : undefined }),
      ),
    ];

    // 5 unread, not 8: the three failed workers wear red, not orange.
    const raw = filterCounts(payload, {}, NOW);
    expect(raw.unread).toBe(5);
    expect(raw.error).toBe(3);

    const counts = filterCounts(roomRoster(payload), {}, NOW);
    expect(counts.unread).toBe(1);
    expect(counts.error).toBe(0);

    // ...and the list behind the button agrees with its face, which is the
    // actual contract: a pressed red button must not empty the page.
    expect(applyFilter(roomRoster(payload), {}, ['error'], NOW)).toHaveLength(counts.error);
    expect(applyFilter(roomRoster(payload), {}, ['unread'], NOW)).toHaveLength(counts.unread);
  });
});
