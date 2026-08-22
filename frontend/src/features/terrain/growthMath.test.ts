import { describe, expect, it } from 'vitest';
import {
  compact,
  cumulative,
  dayEpoch,
  monthTicks,
  monthlyRollup,
  nearestTime,
  niceTicks,
  sumSince,
  valueAt,
  velocityBars,
  velocityBinUnit,
  windowBars,
  windowPoints,
  type GrowthDay,
} from './growthMath';

const day = (date: string, over: Partial<GrowthDay> = {}): GrowthDay => ({
  date,
  commits: 0,
  added: 0,
  removed: 0,
  born: 0,
  died: 0,
  ...over,
});

describe('cumulative', () => {
  it('integrates deltas into a running total', () => {
    const days = [
      day('2026-06-01', { added: 100, removed: 0 }),
      day('2026-06-03', { added: 50, removed: 20 }),
    ];
    const pts = cumulative(days, (d) => d.added - d.removed);
    expect(pts.map((p) => p.v)).toEqual([100, 130]);
    expect(pts[0].t).toBe(dayEpoch('2026-06-01'));
  });
});

describe('windowPoints', () => {
  const pts = [
    { t: 100, v: 10 },
    { t: 200, v: 25 },
    { t: 300, v: 30 },
  ];

  it('carries the pre-window total in at the window edge', () => {
    // The codebase didn't restart when the window opened — the curve must
    // enter at its true height.
    expect(windowPoints(pts, 250)).toEqual([
      { t: 250, v: 25 },
      { t: 300, v: 30 },
    ]);
  });

  it('null window means the whole curve', () => {
    expect(windowPoints(pts, null)).toEqual(pts);
  });

  it('a window opening before the curve began adds nothing synthetic', () => {
    expect(windowPoints(pts, 50)).toEqual(pts);
  });
});

describe('sumSince', () => {
  const days = [day('2026-06-01', { commits: 3 }), day('2026-07-01', { commits: 5 })];

  it('scopes the sum to the window the charts show', () => {
    expect(sumSince(days, null, (d) => d.commits)).toBe(8);
    expect(sumSince(days, dayEpoch('2026-06-15'), (d) => d.commits)).toBe(5);
  });
});

describe('niceTicks', () => {
  it('always starts at zero and covers the max with clean steps', () => {
    expect(niceTicks(970)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(niceTicks(9)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('an empty series still yields a drawable axis', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe('compact', () => {
  it('keeps small numbers whole and shortens big ones', () => {
    expect(compact(1284)).toBe('1,284');
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(1_240_000)).toBe('1.24M');
  });

  it('signs a shrink — net change can genuinely go down', () => {
    expect(compact(-42)).toBe('−42');
  });
});

describe('monthTicks', () => {
  it('marks each month boundary inside the window, year on January', () => {
    const ticks = monthTicks(dayEpoch('2025-11-20'), dayEpoch('2026-02-10'));
    expect(ticks.map((t) => t.label)).toEqual(['Dec', 'Jan 2026', 'Feb']);
  });
});

describe('monthlyRollup', () => {
  it('folds days into net rows, newest month first', () => {
    const rows = monthlyRollup([
      day('2026-06-01', { commits: 2, added: 100, removed: 30, born: 3 }),
      day('2026-06-20', { commits: 1, died: 1 }),
      day('2026-07-02', { commits: 4, added: 10, born: 2 }),
    ]);
    expect(rows).toEqual([
      { month: '2026-07', commits: 4, files: 2, lines: 10, born: 2 },
      { month: '2026-06', commits: 3, files: 2, lines: 70, born: 3 },
    ]);
  });

  it('sums born separately from the net files column', () => {
    // born (gross created) and files (net born - died) diverge whenever
    // anything died — the velocity panel needs the gross number the net
    // column can't reconstruct.
    const rows = monthlyRollup([day('2026-06-01', { born: 5, died: 5 })]);
    expect(rows).toEqual([{ month: '2026-06', commits: 0, files: 0, lines: 0, born: 5 }]);
  });
});

describe('velocityBinUnit', () => {
  it('picks the bin width per window preset', () => {
    expect(velocityBinUnit(90)).toBe('day');
    expect(velocityBinUnit(365)).toBe('week');
    expect(velocityBinUnit(null)).toBe('month');
  });
});

describe('velocityBars', () => {
  it('bins one repo\'s born counts by day, one bar per date', () => {
    const bars = velocityBars(
      [{ id: 'skeleton', days: [day('2026-06-14', { born: 2 }), day('2026-06-15', { born: 3 })] }],
      'day',
    );
    expect(bars).toEqual([
      { t: dayEpoch('2026-06-14'), label: 'Jun 14', values: { skeleton: 2 } },
      { t: dayEpoch('2026-06-15'), label: 'Jun 15', values: { skeleton: 3 } },
    ]);
  });

  it('keys multiple repos into the same bar generically, by id', () => {
    // Generic over however many repos are passed — a future facet is just
    // more entries in `values`, not a different code path.
    const bars = velocityBars(
      [
        { id: 'skeleton', days: [day('2026-06-14', { born: 2 })] },
        { id: 'vault', days: [day('2026-06-14', { born: 5 })] },
      ],
      'day',
    );
    expect(bars).toEqual([{ t: dayEpoch('2026-06-14'), label: 'Jun 14', values: { skeleton: 2, vault: 5 } }]);
  });

  it('a Sunday and the Monday before it land in the same ISO week bin', () => {
    // 2026-06-08 is a Monday, 2026-06-14 the Sunday that closes its week.
    const bars = velocityBars(
      [{ id: 'skeleton', days: [day('2026-06-08', { born: 1 }), day('2026-06-14', { born: 4 })] }],
      'week',
    );
    expect(bars).toEqual([{ t: dayEpoch('2026-06-08'), label: 'Jun 8', values: { skeleton: 5 } }]);
  });

  it('a Monday starts its own week, not the one before', () => {
    // 2026-06-15 is the Monday right after 2026-06-14's week closes.
    const bars = velocityBars(
      [{ id: 'skeleton', days: [day('2026-06-14', { born: 1 }), day('2026-06-15', { born: 1 })] }],
      'week',
    );
    expect(bars.map((b) => b.t)).toEqual([dayEpoch('2026-06-08'), dayEpoch('2026-06-15')]);
  });

  it('the last day of a month and the first day of the next land in separate month bins', () => {
    const bars = velocityBars(
      [{ id: 'skeleton', days: [day('2026-05-31', { born: 1 }), day('2026-06-01', { born: 1 })] }],
      'month',
    );
    expect(bars).toEqual([
      { t: dayEpoch('2026-05-01'), label: 'May', values: { skeleton: 1 } },
      { t: dayEpoch('2026-06-01'), label: 'Jun', values: { skeleton: 1 } },
    ]);
  });

  it('labels January with its year', () => {
    const bars = velocityBars([{ id: 'skeleton', days: [day('2026-01-15', { born: 1 })] }], 'month');
    expect(bars[0].label).toBe('Jan 2026');
  });

  it('an empty repo list bins to nothing', () => {
    expect(velocityBars([], 'day')).toEqual([]);
    expect(velocityBars([{ id: 'skeleton', days: [] }], 'month')).toEqual([]);
  });
});

describe('windowBars', () => {
  const bars = [
    { t: 100, label: 'a', values: { skeleton: 1 } },
    { t: 200, label: 'b', values: { skeleton: 2 } },
    { t: 300, label: 'c', values: { skeleton: 3 } },
  ];

  it('keeps bars at or after the window edge', () => {
    expect(windowBars(bars, 200)).toEqual([bars[1], bars[2]]);
  });

  it('null window means every bar', () => {
    expect(windowBars(bars, null)).toEqual(bars);
  });

  it('a window after every bar empties the result', () => {
    expect(windowBars(bars, 1000)).toEqual([]);
  });
});

describe('the crosshair maths', () => {
  it('snaps to the nearest recorded day across every series', () => {
    expect(nearestTime([[100, 300], [200]], 260)).toBe(300);
  });

  it('reads a cumulative curve as holding steady between events', () => {
    const pts = [
      { t: 100, v: 10 },
      { t: 300, v: 30 },
    ];
    expect(valueAt(pts, 200)).toBe(10); // between events the total hasn't moved
    expect(valueAt(pts, 50)).toBeNull(); // before the curve began: no claim
  });
});
