import { describe, expect, it } from 'vitest';
import { buildHeatmap, cellBackground, intensityBucket } from './heatmapMath';

describe('intensityBucket', () => {
  it('maps zero to the empty level', () => {
    expect(intensityBucket(0, 10)).toBe(0);
  });

  it('renders everything at full strength when the busiest day is 1', () => {
    expect(intensityBucket(1, 1)).toBe(4);
  });

  it('bins quartiles against the busiest day, boundaries inclusive on the low side', () => {
    expect(intensityBucket(1, 4)).toBe(1); // 0.25 -> level 1
    expect(intensityBucket(2, 4)).toBe(2); // 0.50 -> level 2
    expect(intensityBucket(3, 4)).toBe(3); // 0.75 -> level 3
    expect(intensityBucket(4, 4)).toBe(4);
  });
});

describe('cellBackground', () => {
  it('uses the empty var at level 0', () => {
    expect(cellBackground(0, 5, 210)).toBe('var(--p-hm-empty)');
  });

  it("uses the person's hue at the level lightness otherwise", () => {
    expect(cellBackground(5, 5, 210)).toBe('hsl(210 70% 26%)');
    expect(cellBackground(1, 4, 210)).toBe('hsl(210 70% 60%)');
  });
});

describe('buildHeatmap', () => {
  it('returns null with no days', () => {
    expect(buildHeatmap([])).toBeNull();
  });

  it('pads a single day out to one whole Mon-Sun week', () => {
    // 2026-07-09 is a Thursday.
    const model = buildHeatmap([{ date: '2026-07-09', count: 2 }]);
    expect(model).not.toBeNull();
    expect(model!.weeks).toHaveLength(1);
    expect(model!.weeks[0].map((c) => c.date)).toEqual([
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ]);
    expect(model!.weeks[0].map((c) => c.count)).toEqual([0, 0, 0, 2, 0, 0, 0]);
    expect(model!.maxCount).toBe(2);
  });

  it('spans from the first mention week through the last, weeks always 7 cells', () => {
    // Tue 2026-06-30 .. Thu 2026-07-09 -> Mon 06-29 .. Sun 07-12, two columns.
    const model = buildHeatmap([
      { date: '2026-06-30', count: 1 },
      { date: '2026-07-09', count: 3 },
    ]);
    expect(model!.weeks).toHaveLength(2);
    for (const week of model!.weeks) expect(week).toHaveLength(7);
    expect(model!.weeks[0][0].date).toBe('2026-06-29');
    expect(model!.weeks[1][6].date).toBe('2026-07-12');
  });

  it('does not care about the order the API sends days in', () => {
    const model = buildHeatmap([
      { date: '2026-07-09', count: 3 },
      { date: '2026-06-30', count: 1 },
    ]);
    expect(model!.weeks[0][0].date).toBe('2026-06-29');
    expect(model!.weeks[1][6].date).toBe('2026-07-12');
  });

  it('labels each week that starts a new month, first week always labeled', () => {
    const model = buildHeatmap([
      { date: '2026-06-30', count: 1 },
      { date: '2026-07-09', count: 3 },
    ]);
    // Week 0 starts Mon 06-29 (June), week 1 starts Mon 07-06 (July).
    expect(model!.monthLabels).toEqual([
      { week: 0, label: 'Jun' },
      { week: 1, label: 'Jul' },
    ]);
  });

  it('crosses year boundaries without a phantom label', () => {
    // Wed 2025-12-31 .. Fri 2026-01-02 pads to one week (Mon 12-29 .. Sun 01-04):
    // a single column labeled by its Monday's month.
    const model = buildHeatmap([
      { date: '2025-12-31', count: 1 },
      { date: '2026-01-02', count: 1 },
    ]);
    expect(model!.weeks).toHaveLength(1);
    expect(model!.monthLabels).toEqual([{ week: 0, label: 'Dec' }]);
  });
});
