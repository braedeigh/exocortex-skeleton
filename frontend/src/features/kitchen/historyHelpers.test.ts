import { describe, expect, it } from 'vitest';
import {
  buildHistoryRows,
  computeSpendStats,
  daysAgoLabel,
  nextHistorySort,
  sortHistoryRows,
} from './historyHelpers';

const NOW = new Date('2026-07-09T12:00:00').getTime();

describe('buildHistoryRows', () => {
  it('computes days-since from last-bought', () => {
    const rows = buildHistoryRows(
      { kale: 'vegetables', chips: '' },
      { kale: 4 },
      { kale: '2026-07-07' },
      { kale: 'safe' },
      NOW,
    );
    const kale = rows.find((r) => r.name === 'kale')!;
    expect(kale).toMatchObject({ count: 4, daysSince: 2, safety: 'safe' });
    const chips = rows.find((r) => r.name === 'chips')!;
    expect(chips).toMatchObject({ category: 'other', lastBought: null, daysSince: null });
  });
});

describe('sortHistoryRows', () => {
  const rows = buildHistoryRows(
    { a: 'x', b: 'y', c: 'z' },
    { a: 1, b: 3 },
    { a: '2026-07-01', c: '2026-07-05' },
    {},
    NOW,
  );

  it('last_bought_desc puts dated rows first, newest first', () => {
    expect(sortHistoryRows(rows, 'last_bought_desc').map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });

  it('last_bought_asc puts undated rows first, oldest date next (old-code parity)', () => {
    expect(sortHistoryRows(rows, 'last_bought_asc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
  });

  it('count sorts break ties alphabetically', () => {
    expect(sortHistoryRows(rows, 'count_desc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
  });
});

describe('nextHistorySort', () => {
  it('flips direction on the current column, starts new columns desc', () => {
    expect(nextHistorySort('name_desc', 'name')).toBe('name_asc');
    expect(nextHistorySort('name_asc', 'name')).toBe('name_desc');
    expect(nextHistorySort('name_asc', 'count')).toBe('count_desc');
  });
});

describe('daysAgoLabel', () => {
  it('formats the ladder of ranges', () => {
    expect(daysAgoLabel(null)).toBe('—');
    expect(daysAgoLabel(0)).toBe('today');
    expect(daysAgoLabel(1)).toBe('yesterday');
    expect(daysAgoLabel(12)).toBe('12d ago');
    expect(daysAgoLabel(70)).toBe('10w ago');
    expect(daysAgoLabel(400)).toBe('1.1y ago');
  });
});

describe('computeSpendStats', () => {
  it('returns null with no priced trips', () => {
    expect(computeSpendStats([{ date: '2026-07-01' }])).toBeNull();
  });

  it('computes last, 5-trip average, 30-day total, and sparkline data', () => {
    const trips = [
      { date: '2026-07-01', total: 50 },
      { date: '2026-05-01', total: 100 },
      { date: '2026-07-05', total: 70 },
    ];
    const s = computeSpendStats(trips, new Date('2026-07-09T12:00:00'))!;
    expect(s.lastTotal).toBe(70);
    expect(s.lastDate).toBe('2026-07-05');
    expect(s.last5Avg).toBeCloseTo((100 + 50 + 70) / 3);
    expect(s.last30Total).toBe(120);
    expect(s.tripCount).toBe(3);
    expect(s.sparkData).toEqual([100, 50, 70]);
  });
});
