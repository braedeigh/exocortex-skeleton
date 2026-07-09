import { describe, expect, it } from 'vitest';
import {
  SPARK_BAR_W,
  SPARK_GAP,
  SPARK_H,
  buildMonthRange,
  buildSparkline,
  monthKey,
  monthKeyLabel,
  roundedTopBarPath,
} from './sparkline';

const NOW = new Date('2026-07-09T12:00:00');

describe('monthKey / monthKeyLabel', () => {
  it('slices the YYYY-MM key', () => {
    expect(monthKey('2026-05-12')).toBe('2026-05');
  });

  it('labels a key as "Mon YYYY"', () => {
    expect(monthKeyLabel('2026-05')).toBe('May 2026');
  });
});

describe('buildMonthRange', () => {
  it('is empty with no dates', () => {
    expect(buildMonthRange([], NOW)).toEqual([]);
  });

  it('spans first mention month through the current month inclusive', () => {
    expect(buildMonthRange(['2026-05-10', '2026-07-01'], NOW)).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('crosses year boundaries', () => {
    expect(buildMonthRange(['2025-11-20'], NOW)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('is empty when the first date is in a future month', () => {
    expect(buildMonthRange(['2026-08-01'], NOW)).toEqual([]);
  });
});

describe('roundedTopBarPath', () => {
  it('rounds only the top corners, flush at the baseline', () => {
    expect(roundedTopBarPath(0, 30, 8, 6, 2)).toBe(
      'M0,36 L0,32 Q0,30 2,30 L6,30 Q8,30 8,32 L8,36 Z',
    );
  });

  it('clamps the radius to half-width and height', () => {
    // h=1 → r clamps to 1.
    expect(roundedTopBarPath(0, 35, 8, 1, 2)).toBe('M0,36 L0,36 Q0,35 1,35 L7,35 Q8,35 8,36 L8,36 Z');
  });
});

describe('buildSparkline', () => {
  it('returns null with nothing to draw', () => {
    expect(buildSparkline([], NOW)).toBeNull();
  });

  it('bins by month: accent bars scaled to the busiest month, stubs for quiet months', () => {
    const spec = buildSparkline(['2026-05-10', '2026-05-12', '2026-07-01'], NOW);
    expect(spec).not.toBeNull();
    const { width, height, bars } = spec!;

    expect(height).toBe(SPARK_H);
    expect(width).toBe(3 * SPARK_BAR_W + 2 * SPARK_GAP); // 28

    expect(bars.map((b) => b.filled)).toEqual([true, false, true]);
    // May: 2 of max 2 → full 30px bar (y = 6).
    expect(bars[0].path).toContain('L0,8 Q0,6');
    // June: zero → 3px stub (y = 33).
    expect(bars[1].path.startsWith('M10,36')).toBe(true);
    expect(bars[1].path).toContain('Q10,33');
    // July: 1 of max 2 → 15px bar (y = 21).
    expect(bars[2].path).toContain('Q20,21');
  });

  it('keeps a 1-day month visible with the 4px minimum bar', () => {
    // Jan has 10 mentions, Feb has 1 → 30 * 1/10 = 3 rounds up to the 4px floor.
    const dates = [...Array(10).fill('2026-01-05'), '2026-02-05'];
    const spec = buildSparkline(dates, new Date('2026-02-15T12:00:00'));
    const feb = spec!.bars[1];
    expect(feb.filled).toBe(true);
    expect(feb.path).toContain(`,${SPARK_H - 4 + 2} Q`); // y + r with h=4 → 34
  });

  it('writes per-bar tooltips with day pluralization', () => {
    const spec = buildSparkline(['2026-05-10', '2026-05-12', '2026-07-01'], NOW);
    expect(spec!.bars.map((b) => b.title)).toEqual([
      'May 2026 — 2 days',
      'Jun 2026 — 0 days',
      'Jul 2026 — 1 day',
    ]);
  });
});
