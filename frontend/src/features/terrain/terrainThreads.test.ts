import { describe, expect, it } from 'vitest';
import type { CreekCall, CreekData, CreekFile } from '../creek/api';
import {
  buildThreads,
  collectionLastWrite,
  heatThreads,
  THREAD_REPO_ID,
} from './terrainThreads';

const call = (collection: string, verb: CreekCall['verb'], line = 1): CreekCall => ({
  line,
  verb,
  collection,
  snippet: `store.${verb}("${collection}")`,
});

const file = (path: string, calls: CreekCall[]): CreekFile => ({
  path,
  area: 'routes',
  calls,
});

const creek = (
  files: CreekFile[],
  collections: Array<{ id: string; last_write?: string | null; last_write_day?: string | null }>,
): CreekData => ({
  generated: '2026-08-27T12:00:00',
  days: 14,
  journal_since: '2026-08-21T00:00:00',
  files,
  unresolved: [],
  collections: collections.map((c) => ({
    id: c.id,
    backing: 'json' as const,
    reads: 0,
    writes: 0,
    callers: [],
    last_write: c.last_write ?? null,
    last_write_day: c.last_write_day ?? null,
  })),
});

describe('buildThreads — writer to reader, through a collection', () => {
  it('threads a writer to a reader of the same collection', () => {
    const t = buildThreads(
      creek(
        [file('routes/a.py', [call('todos', 'mutate')]), file('routes/b.py', [call('todos', 'read')])],
        [{ id: 'todos' }],
      ),
    );
    expect(t).toHaveLength(1);
    expect(t[0].sourceId).toBe(`${THREAD_REPO_ID}:file:routes/a.py`);
    expect(t[0].targetId).toBe(`${THREAD_REPO_ID}:file:routes/b.py`);
    expect(t[0].collection).toBe('todos');
  });

  it('counts mutate as a write — a read-modify-write is how most writing happens here', () => {
    const withMutate = buildThreads(
      creek(
        [file('a.py', [call('c', 'mutate')]), file('b.py', [call('c', 'read')])],
        [{ id: 'c' }],
      ),
    );
    expect(withMutate).toHaveLength(1);
  });

  it('never threads a file to itself', () => {
    const t = buildThreads(
      creek([file('a.py', [call('c', 'write'), call('c', 'read')])], [{ id: 'c' }]),
    );
    expect(t).toEqual([]);
  });

  it('does not thread two readers to each other — nothing flows between them', () => {
    const t = buildThreads(
      creek([file('a.py', [call('c', 'read')]), file('b.py', [call('c', 'read')])], [{ id: 'c' }]),
    );
    expect(t).toEqual([]);
  });

  it('collapses a pair sharing several collections to the freshest one', () => {
    const t = buildThreads(
      creek(
        [
          file('a.py', [call('old', 'write'), call('new', 'write')]),
          file('b.py', [call('old', 'read'), call('new', 'read')]),
        ],
        [
          { id: 'old', last_write: '2026-08-01T00:00:00' },
          { id: 'new', last_write: '2026-08-27T00:00:00' },
        ],
      ),
    );
    expect(t).toHaveLength(1);
    expect(t[0].collection).toBe('new');
  });

  it('keeps both directions when two files write and read each other', () => {
    const t = buildThreads(
      creek(
        [
          file('a.py', [call('x', 'write'), call('y', 'read')]),
          file('b.py', [call('x', 'read'), call('y', 'write')]),
        ],
        [{ id: 'x' }, { id: 'y' }],
      ),
    );
    expect(t).toHaveLength(2);
    expect(new Set(t.map((th) => th.collection))).toEqual(new Set(['x', 'y']));
  });

  it('is stable in order, so a re-render never reshuffles what draws on top', () => {
    const payload = creek(
      [
        file('z.py', [call('c', 'write')]),
        file('a.py', [call('c', 'write')]),
        file('m.py', [call('c', 'read')]),
      ],
      [{ id: 'c' }],
    );
    expect(buildThreads(payload).map((t) => t.sourceId)).toEqual(
      buildThreads(payload).map((t) => t.sourceId),
    );
    expect(buildThreads(payload)[0].sourceId).toContain('a.py');
  });

  it('survives an empty or missing payload rather than throwing at the caller', () => {
    expect(buildThreads(null)).toEqual([]);
    expect(buildThreads(undefined)).toEqual([]);
    expect(buildThreads(creek([], []))).toEqual([]);
  });
});

describe('collectionLastWrite — exact when there is one, day-coarse when there is not', () => {
  it('prefers the journal stamp over the day counter', () => {
    const exact = collectionLastWrite('2026-08-27T16:50:01', '2026-08-20');
    expect(exact).toBe(Date.parse('2026-08-27T16:50:01') / 1000);
  });

  it('falls back to NOON of the coarse day, not midnight', () => {
    expect(collectionLastWrite(null, '2026-08-26')).toBe(
      Date.parse('2026-08-26T12:00:00') / 1000,
    );
  });

  it('is null when nothing has ever seen it move — quiet is not the same as unknown', () => {
    expect(collectionLastWrite(null, null)).toBeNull();
  });
});

describe('heatThreads — lit on the same schema as the dots', () => {
  const NOW = 1_700_000_000;
  const th = (lastWrite: number | null) => ({
    sourceId: 'a',
    targetId: 'b',
    collection: 'c',
    lastWrite,
    t: 0,
  });

  it('is dark for a thread nothing has ever sent data down', () => {
    expect(heatThreads([th(null)], 86400, NOW)[0].t).toBe(0);
  });

  it('burns brightest the instant the data moved, and fades with age', () => {
    const [now] = heatThreads([th(NOW)], 86400, NOW);
    const [day] = heatThreads([th(NOW - 86400)], 86400, NOW);
    const [week] = heatThreads([th(NOW - 7 * 86400)], 86400, NOW);
    expect(now.t).toBeGreaterThan(day.t);
    expect(day.t).toBeGreaterThan(week.t);
  });

  it('reaches the TOP of the ramp when it just fired — the whole point', () => {
    // Regression guard. Routing this through normalizeHeat capped every thread
    // at 0.5, so the gold end of the ramp was unreachable and threads never got
    // brighter however recently they had fired.
    expect(heatThreads([th(NOW)], 86400, NOW)[0].t).toBeCloseTo(1, 6);
  });

  it('halves per half-life, so age reads off the ramp directly', () => {
    expect(heatThreads([th(NOW - 86400)], 86400, NOW)[0].t).toBeCloseTo(0.5, 6);
    expect(heatThreads([th(NOW - 2 * 86400)], 86400, NOW)[0].t).toBeCloseTo(0.25, 6);
  });

  it('never mutates the array it was handed', () => {
    const input = [th(NOW)];
    heatThreads(input, 86400, NOW);
    expect(input[0].t).toBe(0);
  });

  it('degrades to dark rather than NaN on a nonsense lens', () => {
    expect(heatThreads([th(NOW)], 0, NOW)[0].t).toBe(0);
    expect(heatThreads([th(NOW)], -1, NOW)[0].t).toBe(0);
  });
});
