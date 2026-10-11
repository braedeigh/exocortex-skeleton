import { describe, expect, it } from 'vitest';
import {
  UNFILED,
  clockOf,
  excerpt,
  findTerm,
  fitZoom,
  POND_ZOOMS,
  DEFAULT_LAYOUT,
  cardHeight,
  dayLabel,
  hourLines,
  labelStep,
  layoutPond,
  parseMinutes,
  polylinePoints,
  pondDays,
  threadLine,
  threadPoints,
  filesBySession,
  layoutWorking,
  sessionOnDay,
  workingDays,
  writeWeight,
  type PondCard,
  type PondFileEvent,
  type PondSession,
  type PondTurn,
  type PondWorking,
  type PondWrite,
} from './pondMath';

function card(
  id: string,
  day: string,
  ts: string | null,
  tags: string[] = [],
  body = id,
): PondCard {
  return { id, day, ts, who: 'B', kind: 'line', tags, body };
}

describe('parseMinutes', () => {
  it('reads the pool\'s REAL format — a full datetime — not just a bare clock', () => {
    // The bug that broke the whole time axis: cards carry
    // "2026-07-06 08:46:00", the original regex demanded the clock at the
    // START of the string, so every card parsed to null, sank to the untimed
    // slot, and the pond drew nonsense without erroring. This is the load-
    // bearing test of the module.
    expect(parseMinutes('2026-07-06 08:46:00')).toBe(526);
    expect(parseMinutes('2026-07-06 00:00:00')).toBe(0);
    expect(parseMinutes('2026-08-05 23:20:45')).toBe(1400);
    expect(parseMinutes('2026-07-06T08:46:00')).toBe(526);
  });

  it('still reads a bare clock time as minutes past midnight', () => {
    expect(parseMinutes('00:00')).toBe(0);
    expect(parseMinutes('09:30')).toBe(570);
    expect(parseMinutes('23:59')).toBe(1439);
    expect(parseMinutes('08:05:44')).toBe(485);
  });

  it('returns null rather than 0 for a missing or impossible time', () => {
    // A card with no time is not a card written at midnight — collapsing them
    // would silently stack untimed cards at the top of the column.
    expect(parseMinutes(null)).toBeNull();
    expect(parseMinutes('')).toBeNull();
    expect(parseMinutes('nope')).toBeNull();
    expect(parseMinutes('25:00')).toBeNull();
    expect(parseMinutes('10:75')).toBeNull();
    // A bare date has no clock in it at all.
    expect(parseMinutes('2026-07-06')).toBeNull();
  });
});

describe('clockOf', () => {
  it('shows just the clock, whatever shape the timestamp came in', () => {
    expect(clockOf('2026-07-06 08:46:00')).toBe('08:46');
    expect(clockOf('09:30')).toBe('09:30');
    expect(clockOf(null)).toBeNull();
    expect(clockOf('2026-07-06')).toBeNull();
  });
});

describe('layoutPond — clock mode', () => {
  it('gives each day its own column, left to right in date order', () => {
    const layout = layoutPond([
      card('c', '2026-08-09', '10:00'),
      card('a', '2026-07-06', '10:00'),
      card('b', '2026-08-01', '10:00'),
    ]);
    expect(layout.columns.map((col) => col.day)).toEqual([
      '2026-07-06', '2026-08-01', '2026-08-09',
    ]);
    expect(layout.columns[0].x).toBeLessThan(layout.columns[1].x);
  });

  it('places a card at its hour — a 2am card sits above a 2pm one', () => {
    const layout = layoutPond([
      card('night', '2026-08-09', '02:00'),
      card('afternoon', '2026-08-09', '14:00'),
    ]);
    const [night, afternoon] = layout.columns[0].cards;
    expect(night.card.id).toBe('night');
    expect(afternoon.y).toBeGreaterThan(night.y);
  });

  it('puts every dot at EXACTLY its minute — no collision nudging at all', () => {
    // Pushing colliding dots down drew them at times she didn't write;
    // stepping them sideways drew entries minutes apart as a row. Both were
    // the layout lying to protect the layout. Now close times simply overlap,
    // and the translucent ink (CSS) turns the pile into a darker blot.
    const { top, dayHeight } = DEFAULT_LAYOUT;
    const layout = layoutPond([
      card('noon', '2026-08-09', '12:00'),
      card('near', '2026-08-09', '12:03'),
      card('nearer', '2026-08-09', '12:04'),
    ]);
    const [noon, near, nearer] = layout.columns[0].cards;
    expect(noon.y).toBeCloseTo(top + dayHeight / 2, 5);
    expect(near.y).toBeCloseTo(top + (723 / 1440) * dayHeight, 5);
    expect(nearer.y).toBeCloseTo(top + (724 / 1440) * dayHeight, 5);
  });

  it('keeps a same-minute burst fused at one spot, dead centre of its day', () => {
    const burst = Array.from({ length: 6 }, (_, i) => card(`b${i}`, '2026-08-09', '11:00'));
    const placed = layoutPond(burst).columns[0].cards;
    expect(new Set(placed.map((p) => p.y)).size).toBe(1);
    expect(new Set(placed.map((p) => p.x)).size).toBe(1);
    const col = layoutPond(burst).columns[0];
    expect(placed[0].x + placed[0].w / 2).toBeCloseTo(col.cx, 5);
  });

  it('sinks untimed cards to the bottom of their day', () => {
    const layout = layoutPond([
      card('untimed', '2026-08-09', null),
      card('late', '2026-08-09', '23:00'),
    ]);
    const ids = layout.columns[0].cards.map((p) => p.card.id);
    expect(ids).toEqual(['late', 'untimed']);
  });

  it('orders identically-timed cards by id so renders do not jitter', () => {
    const one = layoutPond([card('z', '2026-08-09', '11:00'), card('a', '2026-08-09', '11:00')]);
    const two = layoutPond([card('a', '2026-08-09', '11:00'), card('z', '2026-08-09', '11:00')]);
    expect(one.columns[0].cards.map((p) => p.card.id)).toEqual(['a', 'z']);
    expect(two.columns[0].cards.map((p) => p.card.id)).toEqual(['a', 'z']);
  });

  it('keeps the canvas tall enough that the last minutes of the day fit', () => {
    const many = Array.from({ length: 200 }, (_, i) => card(`b${i}`, '2026-08-09', '23:50'));
    const layout = layoutPond(many);
    const lowest = Math.max(...layout.columns[0].cards.map((p) => p.y + p.h));
    expect(layout.height).toBeGreaterThan(lowest);
  });

  it('draws the full day even when only one card landed in it', () => {
    // The empty room IS the information in clock mode — a quiet day should read
    // as a tall nearly-empty column, not collapse to the height of its one card.
    const layout = layoutPond([card('a', '2026-08-09', '09:00')]);
    expect(layout.height).toBeGreaterThan(DEFAULT_LAYOUT.dayHeight);
  });

  it('handles an empty pond without producing a zero-width canvas', () => {
    const layout = layoutPond([]);
    expect(layout.columns).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('layoutPond — words mode', () => {
  const opts = { mode: 'words' as const, colWidth: 172, fontSize: 13 };

  it('stacks cards flush with no clock gaps between them', () => {
    const layout = layoutPond(
      [card('a', '2026-08-09', '02:00'), card('b', '2026-08-09', '22:00')],
      opts,
    );
    const [first, second] = layout.columns[0].cards;
    // Sixteen hours apart on the clock; adjacent on the page.
    expect(second.y).toBeCloseTo(first.y + first.h + DEFAULT_LAYOUT.cardGap, 5);
  });

  it('keeps time ORDER even though it drops time POSITION', () => {
    const layout = layoutPond(
      [card('late', '2026-08-09', '22:00'), card('early', '2026-08-09', '02:00')],
      opts,
    );
    expect(layout.columns[0].cards.map((p) => p.card.id)).toEqual(['early', 'late']);
  });

  it('makes a card with more words taller', () => {
    const layout = layoutPond(
      [
        card('short', '2026-08-09', '09:00', [], 'hi'),
        card('long', '2026-08-09', '10:00', [], 'x'.repeat(240)),
      ],
      opts,
    );
    const [short, long] = layout.columns[0].cards;
    expect(long.h).toBeGreaterThan(short.h);
  });

  it('makes the column height the day\'s VOLUME — a wordy day is taller', () => {
    const wordy = layoutPond(
      Array.from({ length: 10 }, (_, i) =>
        card(`w${i}`, '2026-08-09', `0${i}:00`, [], 'x'.repeat(240))),
      opts,
    );
    const thin = layoutPond([card('t', '2026-08-09', '09:00', [], 'hi')], opts);
    expect(wordy.height).toBeGreaterThan(thin.height * 4);
  });

  it('shows a short card in FULL rather than truncating it for tidiness', () => {
    const whole = 'a real entry, all of it, '.repeat(8); // ~200 chars
    const layout = layoutPond([card('c', '2026-08-09', '09:00', [], whole)], opts);
    const placed = layout.columns[0].cards[0];
    expect(placed.text?.text).toBe(whole);
    expect(placed.text?.clippedHead).toBe(false);
    expect(placed.text?.clippedTail).toBe(false);
  });

  it('windows a long card instead of letting it own the column', () => {
    const layout = layoutPond(
      [card('essay', '2026-08-09', '09:00', [], 'x '.repeat(20_000))],
      opts,
    );
    const placed = layout.columns[0].cards[0];
    expect(placed.text!.text.length).toBeLessThan(DEFAULT_LAYOUT.fullBelow + 50);
    expect(placed.text!.clippedTail).toBe(true);
  });

  it('has no hour rules to draw, because there is no clock', () => {
    expect(hourLines({ mode: 'words' })).toEqual([]);
    expect(hourLines({ mode: 'clock' })).toHaveLength(4);
  });
});

describe('layoutPond — `only`, the hide-the-rest filter', () => {
  const pond = [
    card('hit1', '2026-07-06', '09:00', ['ezra']),
    card('miss', '2026-07-06', '10:00', ['other']),
    card('quiet', '2026-07-07', '10:00', ['other']),
    card('hit2', '2026-07-08', '11:00', ['ezra']),
  ];

  it('places only the lit cards', () => {
    const layout = layoutPond(pond, { only: new Set(['ezra']) });
    const ids = layout.columns.flatMap((c) => c.cards.map((p) => p.card.id));
    expect(ids).toEqual(['hit1', 'hit2']);
  });

  it('CLOSES the days it empties, so the thread reads as one run', () => {
    // A thread touching ten days out of thirty-five otherwise spends two-thirds
    // of the width on blank columns. The unfiltered view still carries the
    // silences; this view is for reading the thread.
    const all = layoutPond(pond);
    const filtered = layoutPond(pond, { only: new Set(['ezra']) });
    expect(all.columns.map((c) => c.day)).toEqual([
      '2026-07-06', '2026-07-07', '2026-07-08',
    ]);
    expect(filtered.columns.map((c) => c.day)).toEqual(['2026-07-06', '2026-07-08']);
    expect(filtered.width).toBeLessThan(all.width);
    // Every surviving column holds something — no empty shells left behind.
    expect(filtered.columns.every((c) => c.cards.length > 0)).toBe(true);
  });

  it('lights every tag in the set, so a front keeps all its threads', () => {
    const layout = layoutPond(pond, { only: new Set(['ezra', 'other']) });
    const ids = layout.columns.flatMap((c) => c.cards.map((p) => p.card.id));
    expect(ids).toEqual(['hit1', 'miss', 'quiet', 'hit2']);
  });

  it('repacks the survivors in words mode instead of leaving holes', () => {
    const layout = layoutPond(pond, {
      mode: 'words',
      colWidth: 172,
      fontSize: 13,
      only: new Set(['other']),
    });
    // `quiet` was alone on its day but `miss` sat below `hit1` on the 6th —
    // with hit1 gone it rises to the top rather than holding its old slot.
    expect(layout.columns[0].cards[0].card.id).toBe('miss');
    expect(layout.columns[0].cards[0].y).toBe(DEFAULT_LAYOUT.top);
  });

  it('places everything when the filter is null', () => {
    expect(layoutPond(pond, { only: null }).columns.flatMap((c) => c.cards)).toHaveLength(4);
  });
});

describe('labelStep', () => {
  it('is every day when the columns are wide enough to hold a date', () => {
    expect(labelStep(34)).toBe(1);
    expect(labelStep(96)).toBe(1);
  });

  it('thins out as the columns narrow, so dates never overlap', () => {
    // At four pixels a day there is no room for "Aug 9" on every column.
    expect(labelStep(4)).toBe(8);
    expect(labelStep(12)).toBe(3);
  });

  it('never returns zero, whatever it is handed', () => {
    expect(labelStep(0)).toBeGreaterThan(0);
    expect(labelStep(-5)).toBeGreaterThan(0);
  });
});

describe('cardHeight', () => {
  it('never returns less than one line, even for an empty card', () => {
    const h = cardHeight('', 172, { fontSize: 13 });
    expect(h).toBeGreaterThan(0);
    expect(h).toBe(cardHeight('x', 172, { fontSize: 13 }));
  });

  it('grows without a cap, so a card can run its whole length', () => {
    // What bounds a tall card is `excerpt` windowing it, not a clip here — a
    // card cut off at six lines is a card you have to tap to finish reading.
    const short = cardHeight('x'.repeat(100), 172, { fontSize: 13 });
    const long = cardHeight('x'.repeat(4000), 172, { fontSize: 13 });
    expect(long).toBeGreaterThan(short * 20);
  });

  it('survives a column too narrow to fit a single character', () => {
    // Guards the divide-by-zero-ish path: a 1px column must not produce
    // Infinity lines and a canvas nothing can render.
    expect(Number.isFinite(cardHeight('abc', 1, { fontSize: 13 }))).toBe(true);
  });
});

describe('findTerm', () => {
  it('finds a whole-word hit among the terms', () => {
    expect(findTerm('nothing here yet', ['housing'])).toBe(-1);
    expect(findTerm('the housing thing', ['housing'])).toBe(4);
  });

  it('lets the most distinctive term win, not the earliest', () => {
    // Threads are aliased in natural language ("back under supervision"), so
    // their word lists carry ordinary words beside specific ones. Centring on
    // whichever filler appeared first lands the window almost anywhere.
    const body = 'back to the desk and then a performance review came';
    expect(findTerm(body, ['back', 'performance'])).toBe(body.indexOf('performance'));
  });

  it('still uses a common word when nothing sharper is in the card', () => {
    const body = 'went back to the desk';
    expect(findTerm(body, ['back', 'performance'])).toBe(5);
  });

  it('takes the earliest occurrence of the term that wins', () => {
    const body = 'housing early, then more housing later';
    expect(findTerm(body, ['housing'])).toBe(0);
  });

  it('matches whole words only', () => {
    // `trans` centring on "transit" would put the window on a passage that has
    // nothing to do with the thread and lie about why it's showing it.
    expect(findTerm('caught the transit bus', ['trans'])).toBe(-1);
    expect(findTerm('i am trans', ['trans'])).toBe(5);
    expect(findTerm('willing to try', ['will'])).toBe(-1);
  });

  it('is case-insensitive and survives punctuation at the edges', () => {
    expect(findTerm('About Ezra, yes', ['ezra'])).toBe(6);
    expect(findTerm('(housing)', ['housing'])).toBe(1);
  });

  it('is -1 when there is nothing to look for', () => {
    expect(findTerm('anything', null)).toBe(-1);
    expect(findTerm('anything', [])).toBe(-1);
  });
});

describe('excerpt', () => {
  const long = (marker: string) =>
    `${'alpha '.repeat(120)}${marker} ${'omega '.repeat(120)}`;

  it('returns a short card whole, with nothing clipped', () => {
    const text = 'a short entry';
    expect(excerpt(text, ['short'])).toEqual({
      text, clippedHead: false, clippedTail: false,
    });
  });

  it('centres a long card on where it mentions the thread', () => {
    const got = excerpt(long('housing'), ['housing']);
    expect(got.text).toContain('housing');
    expect(got.clippedHead).toBe(true);
    expect(got.clippedTail).toBe(true);
    // Both sides of the mention, not just what follows it.
    expect(got.text).toContain('alpha');
    expect(got.text).toContain('omega');
  });

  it('falls back to the head when the card never says the thread\'s words', () => {
    // About one long card in seven here. Showing the top and admitting there's
    // more is the honest move; inventing a relevant passage is not.
    const got = excerpt(long('housing'), ['nonexistent']);
    expect(got.clippedHead).toBe(false);
    expect(got.clippedTail).toBe(true);
    expect(got.text.startsWith('alpha')).toBe(true);
  });

  it('falls back to the head when nothing is lit at all', () => {
    const got = excerpt(long('housing'), null);
    expect(got.clippedHead).toBe(false);
    expect(got.text.startsWith('alpha')).toBe(true);
  });

  it('never begins or ends mid-word', () => {
    const got = excerpt(long('housing'), ['housing']);
    expect(got.text.startsWith(' ')).toBe(false);
    expect(got.text.endsWith(' ')).toBe(false);
    for (const word of got.text.split(' ')) {
      expect(['alpha', 'omega', 'housing']).toContain(word);
    }
  });

  it('does not clip the head when the mention is near the start', () => {
    const got = excerpt(`housing ${'omega '.repeat(300)}`, ['housing']);
    expect(got.clippedHead).toBe(false);
    expect(got.text.startsWith('housing')).toBe(true);
  });

  it('re-cuts the same card differently for a different thread', () => {
    // This is what makes lighting a thread change what the pond SAYS, not just
    // what it emphasises.
    const body = `${'alpha '.repeat(120)}housing ${'beta '.repeat(120)}ezra ${'omega '.repeat(120)}`;
    expect(excerpt(body, ['housing']).text).toContain('housing');
    expect(excerpt(body, ['ezra']).text).toContain('ezra');
    expect(excerpt(body, ['ezra']).text).not.toContain('housing');
  });

  it('handles an empty body without throwing', () => {
    expect(excerpt('', ['x'])).toEqual({ text: '', clippedHead: false, clippedTail: false });
  });
});

describe('threadPoints', () => {
  it('collects a lit tag across every day it touches, in time order', () => {
    const layout = layoutPond([
      card('a', '2026-07-06', '10:00', ['long-covid']),
      card('b', '2026-07-06', '11:00', ['other']),
      card('c', '2026-07-20', '09:00', ['long-covid']),
      card('d', '2026-08-08', '22:00', ['long-covid', 'other']),
    ]);
    const hits = threadPoints(layout, new Set(['long-covid']));
    expect(hits.map((p) => p.card.id)).toEqual(['a', 'c', 'd']);
  });

  it('lights every tag in the set at once, so a front covers its threads', () => {
    // A front is a set of threads — lighting "Connection" must light all of
    // them together rather than making her pick one at a time.
    const layout = layoutPond([
      card('a', '2026-07-06', '10:00', ['dating-and-romance']),
      card('b', '2026-07-07', '10:00', ['being-read']),
      card('c', '2026-07-08', '10:00', ['unrelated']),
    ]);
    const hits = threadPoints(layout, new Set(['dating-and-romance', 'being-read']));
    expect(hits.map((p) => p.card.id)).toEqual(['a', 'b']);
  });

  it('is empty when nothing is lit', () => {
    const layout = layoutPond([card('a', '2026-07-06', '10:00', ['t'])]);
    expect(threadPoints(layout, null)).toEqual([]);
    expect(threadPoints(layout, new Set())).toEqual([]);
    expect(threadPoints(layout, new Set(['missing']))).toEqual([]);
  });

  it('lights exactly the cards with NO tags when the unfiled sentinel is lit', () => {
    // A quarter of the journal belongs to no thread — invisible to every
    // tag-based row. The sentinel can't be a real tag because the whole point
    // is the absence of one.
    const layout = layoutPond([
      card('loose', '2026-07-06', '10:00', []),
      card('filed', '2026-07-06', '11:00', ['t']),
      card('loose2', '2026-07-07', '10:00', []),
    ]);
    const hits = threadPoints(layout, new Set([UNFILED]));
    expect(hits.map((p) => p.card.id)).toEqual(['loose', 'loose2']);
  });

  it('filters to only the unfiled cards, same as any lit selection', () => {
    const layout = layoutPond(
      [
        card('loose', '2026-07-06', '10:00', []),
        card('filed', '2026-07-06', '11:00', ['t']),
      ],
      { only: new Set([UNFILED]) },
    );
    expect(layout.columns.flatMap((c) => c.cards.map((p) => p.card.id))).toEqual(['loose']);
  });
});

describe('threadLine — through every dot, at every zoom', () => {
  const busyDay = [
    ...Array.from({ length: 10 }, (_, i) =>
      card(`a${i}`, '2026-07-06', `0${i}:00`, ['t'])),
    card('b', '2026-07-07', '10:00', ['t']),
  ];

  it('gives every card its own vertex, centred on its dot', () => {
    const layout = layoutPond(busyDay, { colWidth: 34 });
    const line = threadLine(layout, new Set(['t']));
    expect(line).toHaveLength(11);
    const dots = threadPoints(layout, new Set(['t']));
    line.forEach((v, i) => {
      expect(v.x).toBeCloseTo(dots[i].x + dots[i].w / 2, 5);
      expect(v.y).toBeCloseTo(dots[i].y + dots[i].h / 2, 5);
    });
  });

  it('never collapses to a per-day average, even zoomed all the way out', () => {
    // An earlier version averaged each day once the columns got narrow, and
    // the auto-fit zoom landed the whole page in that regime — the line
    // "reverted" to a smoothed shape nobody asked for. The line's job is to
    // touch the actual entries; a busy day drawing a vertical run down the
    // column is honest, because those cards are all there, at those times.
    const layout = layoutPond(busyDay, { colWidth: 4, dotSize: 2.5, dayHeight: 190 });
    expect(threadLine(layout, new Set(['t']))).toHaveLength(11);
  });

  it('spans the silences rather than breaking at them', () => {
    // The long flat stretch between two appearances is the thread going quiet,
    // and that is part of its shape — one continuous path, not episodes.
    const layout = layoutPond([
      card('a', '2026-07-06', '10:00', ['t']),
      card('b', '2026-07-07', '10:00', []),
      card('c', '2026-08-08', '10:00', ['t']),
    ]);
    const line = threadLine(layout, new Set(['t']));
    expect(line).toHaveLength(2);
    expect(line[1].x).toBeGreaterThan(line[0].x);
  });

  it('is empty when nothing is lit', () => {
    const layout = layoutPond([card('a', '2026-07-06', '10:00', ['t'])]);
    expect(threadLine(layout, null)).toEqual([]);
  });
});

describe('polylinePoints', () => {
  it('renders points SVG can consume', () => {
    const layout = layoutPond([
      card('a', '2026-07-06', '00:00', ['t']),
      card('b', '2026-07-07', '00:00', ['t']),
    ]);
    expect(polylinePoints(threadLine(layout, new Set(['t']))))
      .toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });
});

describe('dayLabel', () => {
  it('names the month on the first day and drops it while it holds', () => {
    expect(dayLabel('2026-08-09')).toBe('Aug 9');
    expect(dayLabel('2026-08-10', '2026-08-09')).toBe('10');
    expect(dayLabel('2026-09-01', '2026-08-31')).toBe('Sep 1');
  });
});

describe('pondDays', () => {
  it('is the distinct days, ascending', () => {
    expect(pondDays([
      card('a', '2026-08-09', null),
      card('b', '2026-07-06', null),
      card('c', '2026-08-09', null),
    ])).toEqual(['2026-07-06', '2026-08-09']);
  });
});

// --- the working lane -------------------------------------------------------
//
// The half of her day that isn't the journal: messages to agents, files
// written, sessions sitting open. It shares the clock with the cards, which is
// the whole point and also the whole risk — everything below is about the two
// halves agreeing on where a moment is.

function turn(ts: string, session = 's1'): PondTurn {
  return { ts, session };
}

function write(ts: string, over: Partial<PondWrite> = {}): PondWrite {
  return {
    ts, session: 's1', repo: 'skeleton', path: 'app.py', writes: 1, creates: 0,
    ...over,
  };
}

function session(over: Partial<PondSession> = {}): PondSession {
  return {
    id: 's1', title: 'A session', lane: 'coding',
    started: '2026-08-09T10:00:00', last_at: '2026-08-09T12:00:00',
    worked_from: null, worked_to: null,
    ...over,
  };
}

function fileEvent(ts: string, over: Partial<PondFileEvent> = {}): PondFileEvent {
  return { ts, repo: 'skeleton', path: 'old.py', kind: 'delete', commit: 'a commit', ...over };
}

function working(over: Partial<PondWorking> = {}): PondWorking {
  return { turns: [], writes: [], events: [], sessions: [], ...over };
}

describe('layoutPond with a working lane', () => {
  it('leaves the journal exactly where it was when the lane is off', () => {
    // The guarantee that makes the toggle safe: with laneShift at its default
    // of 0 the cards are drawn at the same coordinates they have always been
    // drawn at, so turning a layer on is the ONLY thing that ever moves them.
    const cards = [card('a', '2026-08-09', '12:00')];
    const plain = layoutPond(cards, { mode: 'clock' });
    const withDefault = layoutPond(cards, { mode: 'clock', laneShift: 0 });
    expect(withDefault.columns[0].cards[0].x).toBe(plain.columns[0].cards[0].x);
  });

  it('shifts the journal left of centre to make room', () => {
    const cards = [card('a', '2026-08-09', '12:00')];
    const plain = layoutPond(cards, { mode: 'clock' });
    const shifted = layoutPond(cards, { mode: 'clock', laneShift: 3 });
    expect(shifted.columns[0].cards[0].x).toBe(plain.columns[0].cards[0].x - 3);
  });

  it('gives a column to a day she built on but never wrote on', () => {
    // Doesn't happen against today's data — the journal has covered every day
    // — which is why it needs a test rather than a glance at the page.
    const layout = layoutPond([card('a', '2026-08-08', '12:00')], {
      mode: 'clock',
      extraDays: ['2026-08-09'],
    });
    expect(layout.columns.map((c) => c.day)).toEqual(['2026-08-08', '2026-08-09']);
    expect(layout.columns[1].cards).toEqual([]);
  });

  it('drops the work-only days when a thread filter is on', () => {
    // Filtering means "show me this thread and close the rest up". Keeping a
    // build day she never journaled would re-open a gap the filter just shut.
    const layout = layoutPond(
      [card('a', '2026-08-08', '12:00', ['t']), card('b', '2026-08-10', '12:00')],
      { mode: 'clock', only: new Set(['t']), extraDays: ['2026-08-09'] },
    );
    expect(layout.columns.map((c) => c.day)).toEqual(['2026-08-08']);
  });
});

describe('layoutWorking', () => {
  const cards = [card('a', '2026-08-09', '12:00')];

  it('puts a turn at its own minute, on the same ruler as the cards', () => {
    // A message sent at noon and a card written at noon must land at the same
    // height. If these two ever disagree the page is quietly lying about the
    // thing it exists to show.
    const layout = layoutPond(cards, { mode: 'clock' });
    const w = layoutWorking(layout, working({ turns: [turn('2026-08-09T12:00:00')] }),
      { mode: 'clock' });
    const cardMid = layout.columns[0].cards[0].y + layout.columns[0].cards[0].h / 2;
    const turnMid = w.turns[0].y + w.turns[0].h / 2;
    expect(turnMid).toBeCloseTo(cardMid, 5);
  });

  it('sits the working lane right of centre, opposite the journal', () => {
    const layout = layoutPond(cards, { mode: 'clock', laneShift: 3 });
    const w = layoutWorking(layout, working({ turns: [turn('2026-08-09T12:00:00')] }),
      { mode: 'clock', laneShift: 3 });
    const cx = layout.columns[0].cx;
    const cardMid = layout.columns[0].cards[0].x + layout.columns[0].cards[0].w / 2;
    const turnMid = w.turns[0].x + w.turns[0].w / 2;
    expect(cardMid).toBeCloseTo(cx - 3, 5);
    expect(turnMid).toBeCloseTo(cx + 3, 5);
  });

  it('draws a write as a tick — wider than tall, so it is not a dot', () => {
    const layout = layoutPond(cards, { mode: 'clock' });
    const w = layoutWorking(layout, working({ writes: [write('2026-08-09T12:00:00')] }),
      { mode: 'clock' });
    expect(w.writes[0].w).toBeGreaterThan(w.writes[0].h);
  });

  it('draws nothing at all in words mode', () => {
    // There is no clock in words mode, so there is no honest y for a moment.
    const layout = layoutPond(cards, { mode: 'words' });
    const w = layoutWorking(
      layout,
      working({ turns: [turn('2026-08-09T12:00:00')], sessions: [session()] }),
      { mode: 'words' },
    );
    expect(w).toEqual({ turns: [], writes: [], events: [], spans: [] });
  });

  it('skips work on days the pond has no column for', () => {
    const layout = layoutPond(cards, { mode: 'clock' });
    const w = layoutWorking(layout, working({
      turns: [turn('2026-08-09T12:00:00'), turn('2026-07-01T12:00:00')],
    }), { mode: 'clock' });
    expect(w.turns).toHaveLength(1);
  });

  it('survives a payload it has no columns for at all', () => {
    const layout = layoutPond([], { mode: 'clock' });
    expect(() => layoutWorking(layout, working({ turns: [turn('2026-08-09T12:00:00')] }),
      { mode: 'clock' })).not.toThrow();
  });

  it('places a delete or move at its own minute, like any other point', () => {
    const layout = layoutPond(cards, { mode: 'clock' });
    const w = layoutWorking(layout,
      working({ events: [fileEvent('2026-08-09T12:00:00')] }), { mode: 'clock' });
    const cardMid = layout.columns[0].cards[0].y + layout.columns[0].cards[0].h / 2;
    expect(w.events[0].y + w.events[0].h / 2).toBeCloseTo(cardMid, 5);
  });

  it('skips events on days the pond has no column for', () => {
    const layout = layoutPond(cards, { mode: 'clock' });
    const w = layoutWorking(layout, working({
      events: [fileEvent('2026-08-09T12:00:00'), fileEvent('2026-07-01T12:00:00')],
    }), { mode: 'clock' });
    expect(w.events).toHaveLength(1);
  });

  it('tolerates a payload with no events list at all', () => {
    // The route ships one now, but a cached older payload may not — the
    // drawing degrades to what it was, never to a crash.
    const bare = { turns: [], writes: [], sessions: [] } as unknown as PondWorking;
    const layout = layoutPond(cards, { mode: 'clock' });
    expect(() => layoutWorking(layout, bare, { mode: 'clock' })).not.toThrow();
    expect(workingDays(bare)).toEqual([]);
  });
});

describe('sessionOnDay', () => {
  const opt = { mode: 'clock' as const, top: 0, dayHeight: 1440 };  // 1px a minute

  it('bounds a same-day session by its own two ends', () => {
    const s = session({ started: '2026-08-09T10:00:00', last_at: '2026-08-09T12:00:00' });
    expect(sessionOnDay(s, '2026-08-09', opt)).toEqual({
      y: 600, h: 120, worked: null,
    });
  });

  it('runs a middle day the whole way down — that is what still-open looks like', () => {
    // The case that would go unnoticed if it were wrong: a session drawn one
    // day short still looks like a perfectly plausible session.
    const s = session({ started: '2026-08-07T22:00:00', last_at: '2026-08-09T02:00:00' });
    expect(sessionOnDay(s, '2026-08-07', opt)).toMatchObject({ y: 1320, h: 120 });
    expect(sessionOnDay(s, '2026-08-08', opt)).toMatchObject({ y: 0, h: 1440 });
    expect(sessionOnDay(s, '2026-08-09', opt)).toMatchObject({ y: 0, h: 120 });
  });

  it('is absent on days it was not open', () => {
    const s = session({ started: '2026-08-09T10:00:00', last_at: '2026-08-09T12:00:00' });
    expect(sessionOnDay(s, '2026-08-08', opt)).toBeNull();
    expect(sessionOnDay(s, '2026-08-10', opt)).toBeNull();
  });

  it('marks the worked stretch inside the open one', () => {
    // The whole reason this layer exists: open for four hours, working for
    // one. Both numbers are true and they are not the same number.
    const s = session({
      started: '2026-08-09T10:00:00', last_at: '2026-08-09T14:00:00',
      worked_from: '2026-08-09T11:00:00', worked_to: '2026-08-09T12:00:00',
    });
    expect(sessionOnDay(s, '2026-08-09', opt)).toEqual({
      y: 600, h: 240, worked: { y: 660, h: 60 },
    });
  });

  it('leaves worked null on an open day that wrote nothing', () => {
    const s = session({
      started: '2026-08-08T22:00:00', last_at: '2026-08-09T12:00:00',
      worked_from: '2026-08-09T10:00:00', worked_to: '2026-08-09T11:00:00',
    });
    expect(sessionOnDay(s, '2026-08-08', opt)!.worked).toBeNull();
    expect(sessionOnDay(s, '2026-08-09', opt)!.worked).toEqual({ y: 600, h: 60 });
  });

  it('still draws a session that opened and closed in the same minute', () => {
    const s = session({ started: '2026-08-09T10:00:00', last_at: '2026-08-09T10:00:00' });
    expect(sessionOnDay(s, '2026-08-09', opt)!.h).toBeGreaterThan(0);
  });
});

describe('workingDays', () => {
  it('counts a day whose only trace is a delete or a move', () => {
    expect(workingDays(working({ events: [fileEvent('2026-08-07T12:00:00')] })))
      .toEqual(['2026-08-07']);
  });

  it('counts days work HAPPENED on, not days a window was left open', () => {
    // A conversation left open over a weekend shouldn't mint columns for two
    // days she never touched it.
    expect(workingDays(working({
      turns: [turn('2026-08-09T12:00:00')],
      writes: [write('2026-08-07T09:00:00')],
      sessions: [session({ started: '2026-08-01T10:00:00', last_at: '2026-08-05T10:00:00' })],
    }))).toEqual(['2026-08-07', '2026-08-09']);
  });

  it('is empty when there is nothing to draw', () => {
    expect(workingDays(null)).toEqual([]);
  });
});

describe('writeWeight', () => {
  it('keeps a single edit visible rather than fading it to nothing', () => {
    // A touch that happened must be seen. Fading a real edit away to make a
    // busier one look busier is the drawing lying about what it knows.
    expect(writeWeight(1)).toBeGreaterThanOrEqual(0.35);
    expect(writeWeight(0)).toBeGreaterThanOrEqual(0.35);
  });

  it('rises with the count but never runs off the top', () => {
    expect(writeWeight(30)).toBeGreaterThan(writeWeight(3));
    expect(writeWeight(3)).toBeGreaterThan(writeWeight(1));
    expect(writeWeight(5000)).toBeLessThanOrEqual(1);
  });
});


describe('filesBySession', () => {
  it('groups a session\'s files heaviest first — what it was really doing', () => {
    const w = working({
      writes: [
        write('2026-08-09T10:00:00', { path: 'a.ts', writes: 2 }),
        write('2026-08-09T11:00:00', { path: 'b.ts', writes: 40 }),
        write('2026-08-09T12:00:00', { path: 'c.ts', writes: 2, session: 's2' }),
      ],
    });
    const got = filesBySession(w);
    expect(got.get('s1')!.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
    expect(got.get('s2')!.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('breaks ties on path so the list does not reshuffle between renders', () => {
    const w = working({
      writes: [
        write('2026-08-09T10:00:00', { path: 'z.ts', writes: 3 }),
        write('2026-08-09T11:00:00', { path: 'a.ts', writes: 3 }),
      ],
    });
    expect(filesBySession(w).get('s1')!.map((f) => f.path)).toEqual(['a.ts', 'z.ts']);
  });

  it('is empty, not broken, with nothing to group', () => {
    expect(filesBySession(null).size).toBe(0);
  });
});

describe('fitZoom', () => {
  it('opens at the widest zoom whose days all fit', () => {
    const width = 30 * POND_ZOOMS[2].clock.colWidth;
    expect(fitZoom(30, width)).toBe(2);
  });

  it('falls back to the most zoomed-out step when nothing fits', () => {
    expect(fitZoom(100_000, 100)).toBe(0);
  });
});
