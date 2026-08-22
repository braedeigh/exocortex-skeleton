import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIKI_LAYOUT,
  FAMILIES,
  WORDS_FAMILIES,
  layoutWikiPond,
  matchesWikiTag,
  wikiPondDays,
  wikiTagRows,
  wikiThreadLine,
  polylinePoints,
  type WikiRow,
  type WikiTagRef,
} from './wikiPondMath';

function row(
  id: string,
  family: WikiRow['family'],
  day: string,
  ts: string | null,
  tags: WikiTagRef[] = [],
  body = id,
  title = id,
): WikiRow {
  return { id, family, day, ts, title, body, tags };
}

describe('wikiPondDays', () => {
  it('is the distinct days, ascending', () => {
    expect(wikiPondDays([
      row('a', 'journal', '2026-08-09', null),
      row('b', 'build', '2026-07-06', null),
      row('c', 'todo', '2026-08-09', null),
    ])).toEqual(['2026-07-06', '2026-08-09']);
  });
});

describe('matchesWikiTag', () => {
  it('matches on ns AND tag together, not either alone', () => {
    const r = row('a', 'journal', '2026-08-09', null, [{ ns: 'thread', tag: 'housing' }]);
    expect(matchesWikiTag(r, { ns: 'thread', tag: 'housing' })).toBe(true);
    expect(matchesWikiTag(r, { ns: 'topic', tag: 'housing' })).toBe(false);
    expect(matchesWikiTag(r, { ns: 'thread', tag: 'other' })).toBe(false);
  });

  it('is false with nothing lit', () => {
    const r = row('a', 'journal', '2026-08-09', null, [{ ns: 'thread', tag: 'housing' }]);
    expect(matchesWikiTag(r, null)).toBe(false);
  });
});

describe('layoutWikiPond — clock mode, the lane axis', () => {
  it('gives each day its own column, left to right in date order', () => {
    const layout = layoutWikiPond([
      row('c', 'journal', '2026-08-09', '10:00'),
      row('a', 'journal', '2026-07-06', '10:00'),
      row('b', 'journal', '2026-08-01', '10:00'),
    ]);
    expect(layout.columns.map((c) => c.day)).toEqual([
      '2026-07-06', '2026-08-01', '2026-08-09',
    ]);
    expect(layout.columns[0].x).toBeLessThan(layout.columns[1].x);
  });

  it('draws all four lanes, in the fixed order journal | research | build | todo', () => {
    const layout = layoutWikiPond([
      row('a', 'todo', '2026-08-09', '09:00'),
      row('b', 'build', '2026-08-09', '10:00'),
    ]);
    expect(layout.families).toEqual(['journal', 'research', 'build', 'todo']);
  });

  it('puts each family in its OWN lane — same day, same hour, different x', () => {
    const layout = layoutWikiPond([
      row('j', 'journal', '2026-08-09', '12:00'),
      row('r', 'research', '2026-08-09', '12:00'),
      row('b', 'build', '2026-08-09', '12:00'),
      row('t', 'todo', '2026-08-09', '12:00'),
    ]);
    const placed = layout.columns[0].rows;
    // All four sit at the same minute (same y)...
    const ys = new Set(placed.map((p) => p.y));
    expect(ys.size).toBe(1);
    // ...but four distinct x positions, in lane order.
    const byId = new Map(placed.map((p) => [p.row.id, p]));
    expect(byId.get('j')!.x).toBeLessThan(byId.get('r')!.x);
    expect(byId.get('r')!.x).toBeLessThan(byId.get('b')!.x);
    expect(byId.get('b')!.x).toBeLessThan(byId.get('t')!.x);
  });

  it('places a row at its hour — a 2am row sits above a 2pm one in its lane', () => {
    const layout = layoutWikiPond([
      row('night', 'journal', '2026-08-09', '02:00'),
      row('afternoon', 'journal', '2026-08-09', '14:00'),
    ]);
    const byId = new Map(layout.columns[0].rows.map((p) => [p.row.id, p]));
    expect(byId.get('afternoon')!.y).toBeGreaterThan(byId.get('night')!.y);
  });

  it('sinks untimed rows to the bottom of their OWN lane, not the whole day', () => {
    const layout = layoutWikiPond([
      row('untimed', 'journal', '2026-08-09', null),
      row('late', 'journal', '2026-08-09', '23:00'),
      row('build-untimed', 'build', '2026-08-09', null),
    ]);
    const journalIds = layout.columns[0].rows
      .filter((p) => p.row.family === 'journal')
      .map((p) => p.row.id);
    expect(journalIds).toEqual(['late', 'untimed']);
    // The build lane's untimed row sinks in ITS lane, at the same day-bottom
    // y as the journal lane's untimed row — both lanes share one clock.
    const untimedJournal = layout.columns[0].rows.find((p) => p.row.id === 'untimed')!;
    const untimedBuild = layout.columns[0].rows.find((p) => p.row.id === 'build-untimed')!;
    expect(untimedBuild.y).toBe(untimedJournal.y);
  });

  it('handles an empty pond without producing a zero-width canvas', () => {
    const layout = layoutWikiPond([]);
    expect(layout.columns).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('layoutWikiPond — words mode, the lanes that switch off', () => {
  const opts = { mode: 'words' as const, colWidth: 220, fontSize: 13 };

  it('only draws journal and research lanes', () => {
    const layout = layoutWikiPond([row('a', 'journal', '2026-08-09', '09:00')], opts);
    expect(layout.families).toEqual(['journal', 'research']);
  });

  it('drops build and todo rows entirely rather than drawing them oddly', () => {
    const layout = layoutWikiPond([
      row('j', 'journal', '2026-08-09', '09:00'),
      row('b', 'build', '2026-08-09', '09:00'),
      row('t', 'todo', '2026-08-09', '09:00'),
    ], opts);
    const ids = layout.columns.flatMap((c) => c.rows.map((p) => p.row.id));
    expect(ids).toEqual(['j']);
  });

  it('still opens a column for a day only a switched-off lane touched', () => {
    // The pond's own precedent: a layer switching off must not silently
    // reshuffle the days drawn — that's what `only` filtering is FOR, and
    // it's an explicit ask, not what toggling a mode should do by itself.
    const layout = layoutWikiPond([
      row('j', 'journal', '2026-08-08', '09:00'),
      row('b', 'build', '2026-08-09', '09:00'),
    ], opts);
    expect(layout.columns.map((c) => c.day)).toEqual(['2026-08-08', '2026-08-09']);
    expect(layout.columns[1].rows).toEqual([]);
  });

  it('stacks journal and research flush in their OWN lanes, not on top of each other', () => {
    const layout = layoutWikiPond([
      row('j1', 'journal', '2026-08-09', '02:00', [], 'x'.repeat(50)),
      row('j2', 'journal', '2026-08-09', '22:00', [], 'x'.repeat(50)),
      row('r1', 'research', '2026-08-09', '10:00', [], 'x'.repeat(50)),
    ], opts);
    const byId = new Map(layout.columns[0].rows.map((p) => [p.row.id, p]));
    // j2 stacks under j1 in the journal lane...
    expect(byId.get('j2')!.y).toBeCloseTo(byId.get('j1')!.y + byId.get('j1')!.h + DEFAULT_WIKI_LAYOUT.cardGap, 5);
    // ...while research starts fresh at the top of ITS OWN lane, unaffected
    // by how tall the journal lane got.
    expect(byId.get('r1')!.y).toBe(DEFAULT_WIKI_LAYOUT.top);
    // And research sits to the right of journal — two lanes, not one column.
    expect(byId.get('r1')!.x).toBeGreaterThan(byId.get('j1')!.x);
  });

  it('makes a row with more words taller', () => {
    const layout = layoutWikiPond([
      row('short', 'journal', '2026-08-09', '09:00', [], 'hi'),
      row('long', 'journal', '2026-08-09', '10:00', [], 'x'.repeat(400)),
    ], opts);
    const byId = new Map(layout.columns[0].rows.map((p) => [p.row.id, p]));
    expect(byId.get('long')!.h).toBeGreaterThan(byId.get('short')!.h);
  });
});

describe('wikiTagRows / wikiThreadLine', () => {
  const tag: WikiTagRef = { ns: 'thread', tag: 'housing' };

  it('collects a lit tag across every day and lane it touches, in reading order', () => {
    const layout = layoutWikiPond([
      row('a', 'journal', '2026-07-06', '10:00', [tag]),
      row('b', 'journal', '2026-07-06', '11:00', [{ ns: 'thread', tag: 'other' }]),
      row('c', 'build', '2026-07-20', '09:00', [tag]),
      row('d', 'todo', '2026-08-08', '22:00', [tag, { ns: 'topic', tag: 'other' }]),
    ]);
    const hits = wikiTagRows(layout, tag);
    expect(hits.map((p) => p.row.id)).toEqual(['a', 'c', 'd']);
  });

  it('is empty when nothing is lit or the tag is absent', () => {
    const layout = layoutWikiPond([row('a', 'journal', '2026-07-06', '10:00', [tag])]);
    expect(wikiTagRows(layout, null)).toEqual([]);
    expect(wikiTagRows(layout, { ns: 'thread', tag: 'missing' })).toEqual([]);
  });

  it('draws a vertex per row, centred on its own box, even when the tag jumps lanes', () => {
    const layout = layoutWikiPond([
      row('a', 'journal', '2026-07-06', '10:00', [tag]),
      row('b', 'build', '2026-07-07', '10:00', [tag]),
    ]);
    const line = wikiThreadLine(layout, tag);
    const hits = wikiTagRows(layout, tag);
    expect(line).toHaveLength(2);
    line.forEach((v, i) => {
      expect(v.x).toBeCloseTo(hits[i].x + hits[i].w / 2, 5);
      expect(v.y).toBeCloseTo(hits[i].y + hits[i].h / 2, 5);
    });
    // The jump is real: journal's lane sits left of build's lane.
    expect(line[1].x).not.toBeCloseTo(line[0].x, 0);
  });

  it('renders as SVG-consumable points via the reused pondMath formatter', () => {
    const layout = layoutWikiPond([
      row('a', 'journal', '2026-07-06', '00:00', [tag]),
      row('b', 'journal', '2026-07-07', '00:00', [tag]),
    ]);
    expect(polylinePoints(wikiThreadLine(layout, tag))).toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });
});

describe('FAMILIES / WORDS_FAMILIES', () => {
  it('fixes the lane order the doc specifies', () => {
    expect(FAMILIES).toEqual(['journal', 'research', 'build', 'todo']);
  });

  it('keeps only the two prose families for words mode', () => {
    expect(WORDS_FAMILIES).toEqual(['journal', 'research']);
  });
});
