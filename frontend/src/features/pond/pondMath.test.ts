import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  dayLabel,
  layoutPond,
  parseMinutes,
  polylinePoints,
  pondDays,
  threadPoints,
  type PondCard,
} from './pondMath';

function card(id: string, day: string, ts: string | null, tags: string[] = []): PondCard {
  return { id, day, ts, who: 'B', kind: 'line', tags, preview: id };
}

describe('parseMinutes', () => {
  it('reads a clock time as minutes past midnight', () => {
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
  });
});

describe('layoutPond', () => {
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

  it('pushes a burst apart instead of stacking it into one dot', () => {
    // Six cards in the same minute is a real pattern; drawn honestly they would
    // be a single mark and read as one card.
    const burst = Array.from({ length: 6 }, (_, i) => card(`b${i}`, '2026-08-09', '11:00'));
    const placed = layoutPond(burst).columns[0].cards;
    for (let i = 1; i < placed.length; i += 1) {
      expect(placed[i].y - placed[i - 1].y).toBeCloseTo(DEFAULT_LAYOUT.minGap, 5);
    }
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

  it('grows tall enough to contain a burst that overflowed the day', () => {
    const many = Array.from({ length: 200 }, (_, i) => card(`b${i}`, '2026-08-09', '23:50'));
    const layout = layoutPond(many);
    const lowest = Math.max(...layout.columns[0].cards.map((p) => p.y));
    expect(layout.height).toBeGreaterThan(lowest);
  });

  it('handles an empty pond without producing a zero-width canvas', () => {
    const layout = layoutPond([]);
    expect(layout.columns).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('threadPoints', () => {
  it('collects one thread across every day it touches, in time order', () => {
    const layout = layoutPond([
      card('a', '2026-07-06', '10:00', ['long-covid']),
      card('b', '2026-07-06', '11:00', ['other']),
      card('c', '2026-07-20', '09:00', ['long-covid']),
      card('d', '2026-08-08', '22:00', ['long-covid', 'other']),
    ]);
    expect(threadPoints(layout, 'long-covid').map((p) => p.card.id)).toEqual(['a', 'c', 'd']);
  });

  it('spans the silences rather than breaking at them', () => {
    // The long flat stretch between two appearances is the thread going quiet,
    // and that is part of its shape — one continuous path, not episodes.
    const layout = layoutPond([
      card('a', '2026-07-06', '10:00', ['t']),
      card('b', '2026-07-07', '10:00', []),
      card('c', '2026-08-08', '10:00', ['t']),
    ]);
    expect(threadPoints(layout, 't')).toHaveLength(2);
  });

  it('is empty when nothing is lit', () => {
    const layout = layoutPond([card('a', '2026-07-06', '10:00', ['t'])]);
    expect(threadPoints(layout, null)).toEqual([]);
    expect(threadPoints(layout, 'missing')).toEqual([]);
  });
});

describe('polylinePoints', () => {
  it('renders points SVG can consume', () => {
    const layout = layoutPond([
      card('a', '2026-07-06', '00:00', ['t']),
      card('b', '2026-07-07', '00:00', ['t']),
    ]);
    expect(polylinePoints(threadPoints(layout, 't'))).toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
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
