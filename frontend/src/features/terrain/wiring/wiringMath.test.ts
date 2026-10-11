/**
 * The Wiring room's arithmetic. What's worth pinning is the stuff that would
 * be wrong in a way the eye can't catch: a log ramp that collapses every
 * ordinary edge to a hairline, a waterfall bar that draws a 4us hop as 3ms, a
 * span with no end silently vanishing.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_STROKE,
  MIN_STROKE,
  ROW_H,
  baseName,
  edgeWeight,
  formatDuration,
  layoutBank,
  layoutWaterfall,
  ribbonPath,
  shortFunc,
  strokeFor,
  visitedFiles,
} from './wiringMath';

describe('layoutBank', () => {
  it('stacks rows at the house pitch and reports its own height', () => {
    const bank = layoutBank(['a', 'b', 'c'], (s) => s);
    expect(bank.rows.map((r) => r.y)).toEqual([0, 42, 84]);
    expect(bank.rows[0].cy).toBe(ROW_H / 2);
    expect(bank.height).toBe(124); // 3 rows, 2 gaps — no trailing gap
  });

  it('is empty-safe', () => {
    expect(layoutBank([], (s: string) => s)).toEqual({ rows: [], height: 0 });
  });
});

describe('strokeFor', () => {
  it('floors at the hairline and caps at the max', () => {
    expect(strokeFor(1, 40)).toBe(MIN_STROKE);
    expect(strokeFor(40, 40)).toBeCloseTo(MAX_STROKE);
  });

  it('is logarithmic, so ordinary edges stay distinguishable from the hub', () => {
    // The whole point: on a LINEAR ramp against a max of 40, an edge carrying
    // 2 symbols and one carrying 4 would both round to the hairline. On this
    // one they separate, and the gap between 2 and 4 is bigger than between
    // 20 and 40 — which is the skew the real distribution has.
    const low = strokeFor(4, 40) - strokeFor(2, 40);
    const high = strokeFor(40, 40) - strokeFor(20, 40);
    expect(low).toBeGreaterThan(0.5);
    expect(low).toBeCloseTo(high, 5);
  });

  it('degrades to a hairline when there is nothing to scale against', () => {
    expect(strokeFor(1, 1)).toBe(MIN_STROKE);
    expect(strokeFor(5, 0)).toBe(MIN_STROKE);
  });
});

describe('ribbonPath', () => {
  it('leaves and lands horizontally', () => {
    // Both control points share their endpoint's y, which is what makes the
    // curve flat where it meets a bank instead of stabbing into it.
    expect(ribbonPath(0, 10, 100, 50)).toBe('M 0 10 C 50 10, 50 50, 100 50');
  });
});

describe('layoutWaterfall', () => {
  const spans = [
    { seq: 0, depth: 0, t0_us: 0, t1_us: 1000 },
    { seq: 1, depth: 1, t0_us: 500, t1_us: 750 },
  ];

  it('places every bar as a fraction of the WHOLE trace, not of the widest', () => {
    const rows = layoutWaterfall(spans, 1000, 100);
    expect(rows[0]).toMatchObject({ x: 0, width: 100 });
    expect(rows[1]).toMatchObject({ x: 50, width: 25 });
  });

  it('floors a too-brief hop to a sliver AND says it did', () => {
    // A 4us hop in a 1s trace is a hundredth of a pixel. It has to stay
    // visible, but a bar drawn 500x its real width is a lie the eye cannot
    // check — so the flag is what the view uses to stop showing a duration
    // the bar doesn't support.
    const rows = layoutWaterfall([{ seq: 0, depth: 0, t0_us: 0, t1_us: 4 }], 1_000_000, 640);
    expect(rows[0].width).toBe(2);
    expect(rows[0].floored).toBe(true);
    expect(layoutWaterfall(spans, 1000, 100)[0].floored).toBe(false);
  });

  it('draws a span that never closed out to the end of the axis', () => {
    // "Still going when we stopped looking" — the SSE generator that outlives
    // its own request is the real case.
    const rows = layoutWaterfall([{ seq: 0, depth: 0, t0_us: 250, t1_us: null }], 1000, 100);
    expect(rows[0]).toMatchObject({ x: 25, width: 75 });
  });

  it('never runs a bar off the end of the axis', () => {
    const rows = layoutWaterfall([{ seq: 0, depth: 0, t0_us: 900, t1_us: 5000 }], 1000, 100);
    expect(rows[0].x + rows[0].width).toBeLessThanOrEqual(100);
  });

  it('survives a zero-length trace without dividing by it', () => {
    const rows = layoutWaterfall([{ seq: 0, depth: 0, t0_us: 0, t1_us: 0 }], 0, 100);
    expect(Number.isFinite(rows[0].x)).toBe(true);
    expect(Number.isFinite(rows[0].width)).toBe(true);
  });
});

describe('formatDuration', () => {
  it('coarsens as it grows', () => {
    expect(formatDuration(940)).toBe('940us');
    expect(formatDuration(1500)).toBe('1.5ms');
    expect(formatDuration(71_246)).toBe('71ms');
    expect(formatDuration(2_400_000)).toBe('2.40s');
  });
});

describe('name shortening', () => {
  it('takes the last path segment', () => {
    expect(baseName('routes/observatory.py')).toBe('observatory.py');
    expect(baseName('server.py')).toBe('server.py');
  });

  it('strips the closure noise off a Flask handler qualname', () => {
    // Every route in this app is a closure inside register(), so without this
    // every row on a trace opens with the same fourteen characters.
    expect(shortFunc('register.<locals>.bots_list')).toBe('bots_list');
    expect(shortFunc('_send_to_conversation')).toBe('_send_to_conversation');
  });
});

describe('visitedFiles', () => {
  it('collapses repeat hops into one row per file, keeping first-reached order', () => {
    const out = visitedFiles(
      [
        { dst_repo: 'skeleton', dst: 'a.py', t0_us: 0, t1_us: 100 },
        { dst_repo: 'skeleton', dst: 'b.py', t0_us: 10, t1_us: 40 },
        { dst_repo: 'skeleton', dst: 'a.py', t0_us: 200, t1_us: 260 },
      ],
      300,
    );
    expect(out.map((f) => f.path)).toEqual(['a.py', 'b.py']);
    expect(out[0]).toMatchObject({ hops: 2, us: 160 });
  });

  it('bills an unclosed span to the end of the trace', () => {
    const out = visitedFiles([{ dst_repo: 'r', dst: 'x.py', t0_us: 100, t1_us: null }], 500);
    expect(out[0].us).toBe(400);
  });
});

describe('edgeWeight', () => {
  it('is the count of names crossing the edge, never zero', () => {
    expect(edgeWeight(['read', 'mutate', 'DATA_DIR'])).toBe(3);
    expect(edgeWeight([])).toBe(1); // a bare `import x` is still a real edge
  });
});
