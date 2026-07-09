import { describe, expect, it } from 'vitest';
import {
  UNTAGGED,
  binByRecency,
  computeAllTags,
  daysSince,
  filterAndSort,
  lastDateOf,
  matchesTags,
  monthDay,
  monthYear,
  nextSort,
  relLabel,
  statsLine,
} from './rosterLogic';
import type { RosterPerson } from './types';

const NOW = new Date('2026-07-09T12:00:00');

function person(overrides: Partial<RosterPerson> = {}): RosterPerson {
  return {
    id: 'p1',
    name: 'Ada',
    tags: [],
    blurb: '',
    dates: [],
    last_note: null,
    ...overrides,
  };
}

describe('nextSort', () => {
  it('cycles recent → most → alpha → recent', () => {
    expect(nextSort('recent')).toBe('most');
    expect(nextSort('most')).toBe('alpha');
    expect(nextSort('alpha')).toBe('recent');
  });
});

describe('date labels', () => {
  it('monthYear formats as "Mon YYYY"', () => {
    expect(monthYear('2026-02-14')).toBe('Feb 2026');
  });

  it('monthDay formats as "Mon D"', () => {
    expect(monthDay('2026-06-02')).toBe('Jun 2');
  });

  it('daysSince counts whole days from a noon-anchored date', () => {
    expect(daysSince('2026-07-09', NOW)).toBe(0);
    expect(daysSince('2026-07-06', NOW)).toBe(3);
  });
});

describe('relLabel', () => {
  it('says today for zero or negative gaps', () => {
    expect(relLabel(0)).toBe('today');
    expect(relLabel(-1)).toBe('today');
  });

  it('uses days under a week', () => {
    expect(relLabel(6)).toBe('6d');
  });

  it('uses weeks from 7 to 30 days', () => {
    expect(relLabel(7)).toBe('1w');
    expect(relLabel(30)).toBe('4w');
  });

  it('uses months from 31 to 364 days', () => {
    expect(relLabel(31)).toBe('1mo');
    expect(relLabel(200)).toBe('7mo');
  });

  it('uses years from 365 days', () => {
    expect(relLabel(365)).toBe('1y');
    expect(relLabel(800)).toBe('2y');
  });
});

describe('lastDateOf', () => {
  it('returns the final (newest) date or null', () => {
    expect(lastDateOf(person({ dates: ['2026-01-01', '2026-03-05'] }))).toBe('2026-03-05');
    expect(lastDateOf(person())).toBeNull();
  });
});

describe('computeAllTags', () => {
  it('lowercases, dedupes, and sorts across the roster', () => {
    const people = [
      person({ id: 'a', tags: ['Austin', 'work'] }),
      person({ id: 'b', tags: ['austin', 'family'] }),
    ];
    expect(computeAllTags(people)).toEqual(['austin', 'family', 'work']);
  });
});

describe('matchesTags', () => {
  it('matches everyone when nothing is selected', () => {
    expect(matchesTags(person(), new Set())).toBe(true);
  });

  it('matches tagless people only via the Untagged sentinel', () => {
    expect(matchesTags(person(), new Set([UNTAGGED]))).toBe(true);
    expect(matchesTags(person(), new Set(['work']))).toBe(false);
    expect(matchesTags(person({ tags: ['work'] }), new Set([UNTAGGED]))).toBe(false);
  });

  it('is an any-of match, case-insensitive on the person side', () => {
    const p = person({ tags: ['Austin', 'Work'] });
    expect(matchesTags(p, new Set(['austin']))).toBe(true);
    expect(matchesTags(p, new Set(['family', 'work']))).toBe(true);
    expect(matchesTags(p, new Set(['family']))).toBe(false);
  });
});

describe('filterAndSort', () => {
  const ada = person({ id: 'ada', name: 'Ada', dates: ['2026-07-01'], tags: ['work'] });
  const bea = person({ id: 'bea', name: 'Bea', dates: ['2026-05-01', '2026-07-05'] });
  const cal = person({ id: 'cal', name: 'Cal', dates: [] });
  const dot = person({ id: 'dot', name: 'Dot', dates: ['2026-07-05'] });

  it('alpha sorts by name', () => {
    const out = filterAndSort([dot, cal, bea, ada], 'alpha', new Set());
    expect(out.map((p) => p.id)).toEqual(['ada', 'bea', 'cal', 'dot']);
  });

  it('most sorts by mention-day count, name as tiebreak', () => {
    const out = filterAndSort([dot, cal, bea, ada], 'most', new Set());
    expect(out.map((p) => p.id)).toEqual(['bea', 'ada', 'dot', 'cal']);
  });

  it('recent sorts by newest last-date, dateless people last, name tiebreaks', () => {
    const out = filterAndSort([cal, ada, dot, bea], 'recent', new Set());
    // bea and dot share 2026-07-05 → name order; cal has no dates → last.
    expect(out.map((p) => p.id)).toEqual(['bea', 'dot', 'ada', 'cal']);
  });

  it('applies the tag filter before sorting', () => {
    const out = filterAndSort([dot, cal, bea, ada], 'alpha', new Set(['work']));
    expect(out.map((p) => p.id)).toEqual(['ada']);
  });
});

describe('binByRecency', () => {
  it('bins on the 7 / 31 / 90 day boundaries, dateless into none', () => {
    const week = person({ id: 'w', dates: ['2026-07-02'] }); // 7 days
    const month = person({ id: 'm', dates: ['2026-06-08'] }); // 31 days
    const earlier = person({ id: 'e', dates: ['2026-04-10'] }); // 90 days
    const quiet = person({ id: 'q', dates: ['2026-04-09'] }); // 91 days
    const none = person({ id: 'n', dates: [] });

    const groups = binByRecency([week, month, earlier, quiet, none], NOW);
    expect(groups.week.map((p) => p.id)).toEqual(['w']);
    expect(groups.month.map((p) => p.id)).toEqual(['m']);
    expect(groups.earlier.map((p) => p.id)).toEqual(['e']);
    expect(groups.quiet.map((p) => p.id)).toEqual(['q']);
    expect(groups.none.map((p) => p.id)).toEqual(['n']);
  });

  it('preserves incoming order within a bin', () => {
    const a = person({ id: 'a', dates: ['2026-07-08'] });
    const b = person({ id: 'b', dates: ['2026-07-07'] });
    const groups = binByRecency([a, b], NOW);
    expect(groups.week.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('statsLine', () => {
  it('is empty with no dates', () => {
    expect(statsLine(person())).toBe('');
  });

  it('pluralizes and anchors on the first mention month', () => {
    expect(statsLine(person({ dates: ['2026-02-10'] }))).toBe('1 day · since Feb 2026');
    expect(statsLine(person({ dates: ['2026-02-10', '2026-03-01', '2026-07-04'] }))).toBe(
      '3 days · since Feb 2026',
    );
  });
});
