import { describe, expect, it } from 'vitest';
import {
  formatDwell,
  labelFor,
  rankPlaces,
  windowDates,
  type UsageRecord,
} from './usageRanking';

/** The ranking's pure logic. The alias fold is the load-bearing part: without
 * it a renamed room reports twice at half size, which is exactly how the
 * observatory's real trend was misread before this existed. */

const record: UsageRecord = {
  days: {
    '2026-07-20': {
      tabs: { bots: 10, todos: 20 },
      time: { bots: 600, todos: 300 },
      clicks: { todos: { 'card-edit': 5 } },
    },
    '2026-07-21': {
      // reading-room is the middle hop of the rename (bots → reading-room →
      // observatory). It had a LABEL but no ALIAS for two weeks, which is the
      // regression these tests exist to stop.
      tabs: { observatory: 4, 'reading-room': 5, todos: 6, journal: 3 },
      time: { observatory: 400, 'reading-room': 250, todos: 200, journal: 100 },
      clicks: { todos: { 'card-edit': 2, 'card-add': 1 } },
    },
    '2026-07-22': {
      tabs: { atlas: 1, journal: 2 },
      time: { atlas: 50, journal: 90 },
    },
  },
};

describe('alias folding', () => {
  it('counts a renamed room as one place, not two', () => {
    const ranked = rankPlaces(record, null);
    const keys = ranked.map((p) => p.key);
    expect(keys).not.toContain('bots');
    expect(keys).not.toContain('atlas');
    expect(keys).not.toContain('reading-room');
    expect(keys.filter((k) => k === 'observatory')).toHaveLength(1);
  });

  it('sums the renamed halves together rather than dropping either', () => {
    const observatory = rankPlaces(record, null).find((p) => p.key === 'observatory');
    // bots 600 + observatory 400 + reading-room 250 + atlas 50
    expect(observatory?.seconds).toBe(1300);
    expect(observatory?.visits).toBe(20);
  });

  it('folds every hop of a multi-step rename, not just the first and last', () => {
    // The failure this pins: a key that has a LABEL but no ALIAS reads as a
    // named, plausible, separate room and silently keeps its share out of the
    // total. Naming a key is not the same as folding it.
    expect(labelFor('reading-room')).toBe('Observatory');
    const ranked = rankPlaces(record, null);
    expect(ranked.every((p) => labelFor(p.key) !== 'Reading Room')).toBe(true);
  });
});

describe('ranking', () => {
  it('orders by dwell, not by visits', () => {
    // todos has more visits (26 vs 15) but less dwell (500 vs 1050).
    const ranked = rankPlaces(record, null);
    expect(ranked[0].key).toBe('observatory');
    expect(ranked[1].key).toBe('todos');
  });

  it('keeps the three counts separate', () => {
    const todos = rankPlaces(record, null).find((p) => p.key === 'todos');
    expect(todos).toMatchObject({ visits: 26, seconds: 500, taps: 8 });
  });

  it('drops places with no signal at all', () => {
    const empty = rankPlaces({ days: { '2026-07-20': { tabs: { ghost: 0 } } } }, null);
    expect(empty).toEqual([]);
  });

  it('survives a missing or empty record', () => {
    expect(rankPlaces(null, 7)).toEqual([]);
    expect(rankPlaces({}, null)).toEqual([]);
  });

  it('accepts a bare click total as well as the per-control shape', () => {
    const bare = rankPlaces({ days: { d: { time: { todos: 5 }, clicks: { todos: 9 } } } }, null);
    expect(bare[0].taps).toBe(9);
  });
});

describe('the window', () => {
  it('takes the most recent dates on file', () => {
    expect(windowDates(record, 2)).toEqual(['2026-07-21', '2026-07-22']);
  });

  it('asking for more days than exist returns everything, not a short read', () => {
    expect(windowDates(record, 90)).toHaveLength(3);
  });

  it('null means all of it', () => {
    expect(windowDates(record, null)).toHaveLength(3);
  });

  it('narrowing the window narrows the totals', () => {
    const week = rankPlaces(record, 1).find((p) => p.key === 'journal');
    expect(week?.seconds).toBe(90); // only 07-22
  });
});

describe('labels', () => {
  it('renames through the alias before labelling', () => {
    expect(labelFor('bots')).toBe('Observatory');
  });

  it('uses the name a place wears in the UI, not its route segment', () => {
    expect(labelFor('todos')).toBe('To Do');
    expect(labelFor('map')).toBe('Life Map');
  });

  it('keeps /code and /vscode apart — they are two different surfaces', () => {
    expect(labelFor('code')).toBe('File Viewer');
    expect(labelFor('vscode')).toBe('VS Code');
  });

  it('falls back readably for a route nobody has named yet', () => {
    expect(labelFor('night-runs')).toBe('Night Runs');
  });
});

describe('dwell formatting', () => {
  it('never reports a touched place as zero', () => {
    expect(formatDwell(20)).toBe('<1m');
  });

  it('switches to hours once minutes stop being readable', () => {
    expect(formatDwell(600)).toBe('10m');
    expect(formatDwell(5400)).toBe('1.5h');
    expect(formatDwell(0)).toBe('—');
  });
});
