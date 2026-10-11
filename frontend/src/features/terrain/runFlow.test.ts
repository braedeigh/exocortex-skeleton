import { describe, expect, it } from 'vitest';
import type { CreekCall, CreekCaller, CreekData, CreekFile } from './creek/api';
import type { ScheduledRun } from '../automations/api';
import { buildRunners, downstreamFiles, sinceLabel } from './runFlow';

const call = (collection: string, verb: CreekCall['verb']): CreekCall => ({
  line: 1,
  verb,
  collection,
  snippet: `store.${verb}("${collection}")`,
});

const file = (path: string, calls: CreekCall[]): CreekFile => ({
  path,
  area: 'scripts',
  calls,
});

const caller = (
  name: string,
  writes: number,
  reads = 0,
  f: string | null = null,
): CreekCaller => ({ name, writes, reads, file: f });

const creek = (
  files: CreekFile[],
  collections: Array<{
    id: string;
    callers: CreekCaller[];
    last_write?: string | null;
    last_write_day?: string | null;
  }>,
): CreekData => ({
  generated: '2026-08-27T21:00:00',
  days: 14,
  journal_since: '2026-08-21T00:00:00',
  files,
  unresolved: [],
  collections: collections.map((c) => ({
    id: c.id,
    backing: 'json' as const,
    reads: 0,
    writes: 0,
    callers: c.callers,
    last_write: c.last_write ?? null,
    last_write_day: c.last_write_day ?? null,
  })),
});

const job = (id: string, over: Partial<ScheduledRun> = {}): ScheduledRun => ({
  id,
  name: id,
  description: '',
  schedule: '20 * * * *',
  schedule_human: 'Every hour at :20',
  enabled: true,
  last_run: '2026-08-27T21:20:11',
  last_status: 'ok',
  last_conv_id: null,
  last_cost_usd: null,
  ...over,
});

describe('buildRunners — who ran, what they wrote, who reads it after', () => {
  it('pivots collection-first telemetry into runner-first', () => {
    const r = buildRunners(
      creek(
        [file('scripts/reader.py', [call('footprints', 'read')])],
        [
          {
            id: 'footprints',
            callers: [caller('extract_footprints', 130, 0, 'scripts/extract_footprints.py')],
            last_write: '2026-08-27T21:20:11',
          },
        ],
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0].caller).toBe('extract_footprints');
    expect(r[0].file).toBe('scripts/extract_footprints.py');
    expect(r[0].collections[0].id).toBe('footprints');
    expect(r[0].collections[0].readers).toEqual(['scripts/reader.py']);
  });

  it('drops a caller that only ever read — reading is not running something in', () => {
    const r = buildRunners(
      creek([], [{ id: 'c', callers: [caller('someone', 0, 42)] }]),
    );
    expect(r).toEqual([]);
  });

  it('never resolves gunicorn to a file, and says why in its trigger', () => {
    const r = buildRunners(
      creek([], [{ id: 'todos', callers: [caller('gunicorn', 9, 0, 'routes/todos.py')] }]),
    );
    expect(r[0].file).toBeNull();
    expect(r[0].trigger).toBe('request');
    expect(r[0].triggerDetail).toContain('share this one process');
  });

  it('hangs a schedule off a runner the automations registry knows', () => {
    const r = buildRunners(
      creek([], [{ id: 'x', callers: [caller('spark_morning', 5, 0, 'scripts/spark_morning.py')] }]),
      [job('spark_morning', { schedule_human: 'Every day at 5:00 AM' })],
    );
    expect(r[0].trigger).toBe('schedule');
    expect(r[0].triggerDetail).toBe('Every day at 5:00 AM');
    expect(r[0].lastRun).toBe('2026-08-27T21:20:11');
  });

  it('says so plainly when a runner is on no schedule we know of', () => {
    const r = buildRunners(
      creek([], [{ id: 'x', callers: [caller('mystery', 3, 0, 'scripts/mystery.py')] }]),
    );
    expect(r[0].trigger).toBe('unknown');
    expect(r[0].triggerDetail).toBe('no schedule on record');
  });

  it('gathers one runner across every collection it writes', () => {
    const r = buildRunners(
      creek(
        [],
        [
          { id: 'a', callers: [caller('job', 10, 0, 'scripts/job.py')] },
          { id: 'b', callers: [caller('job', 5, 0, 'scripts/job.py')] },
        ],
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0].writes).toBe(15);
    expect(r[0].collections.map((c) => c.id)).toEqual(['a', 'b']); // busiest first
  });

  it('ranks runners by how much they actually move', () => {
    const r = buildRunners(
      creek(
        [],
        [
          { id: 'a', callers: [caller('quiet', 2), caller('busy', 900)] },
        ],
      ),
    );
    expect(r.map((x) => x.caller)).toEqual(['busy', 'quiet']);
  });

  it('does not list a runner as a reader of its own output', () => {
    const r = buildRunners(
      creek(
        [file('scripts/job.py', [call('c', 'read')]), file('scripts/other.py', [call('c', 'read')])],
        [{ id: 'c', callers: [caller('job', 4, 0, 'scripts/job.py')] }],
      ),
    );
    expect(r[0].collections[0].readers).toEqual(['scripts/other.py']);
  });

  it('survives a missing payload', () => {
    expect(buildRunners(null)).toEqual([]);
    expect(buildRunners(undefined, [])).toEqual([]);
  });
});

describe('downstreamFiles', () => {
  it('unions the readers across every collection, without duplicates', () => {
    const r = buildRunners(
      creek(
        [file('a.py', [call('x', 'read'), call('y', 'read')]), file('b.py', [call('y', 'read')])],
        [
          { id: 'x', callers: [caller('job', 1)] },
          { id: 'y', callers: [caller('job', 1)] },
        ],
      ),
    );
    expect(downstreamFiles(r[0])).toEqual(['a.py', 'b.py']);
  });
});

describe('sinceLabel', () => {
  const NOW = Date.parse('2026-08-27T21:00:00');

  it('reads an unknown time as "never", never as "just now"', () => {
    expect(sinceLabel(null, NOW)).toBe('never');
    expect(sinceLabel('not a date', NOW)).toBe('never');
  });

  it('scales through minutes, hours and days', () => {
    expect(sinceLabel('2026-08-27T20:59:30', NOW)).toBe('just now');
    expect(sinceLabel('2026-08-27T20:30:00', NOW)).toBe('30m ago');
    expect(sinceLabel('2026-08-27T09:00:00', NOW)).toBe('12h ago');
    expect(sinceLabel('2026-08-21T21:00:00', NOW)).toBe('6d ago');
  });

  it('reads a day-only stamp as that day at noon, matching the thread maths', () => {
    expect(sinceLabel('2026-08-26', NOW)).toBe('33h ago');
  });
});
