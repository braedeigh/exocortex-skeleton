import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  hourLabel,
  peakHour,
  rankCommands,
  staleLabel,
  type CommandsRecord,
} from './commandRanking';

function record(over: Partial<CommandsRecord> = {}): CommandsRecord {
  return {
    commands: [],
    by_day: [],
    by_hour: [],
    cold: [],
    days: null,
    kind: 'skill',
    ...over,
  };
}

function cmd(name: string, runs: number, lastDay = '2026-08-20') {
  return {
    name,
    kind: 'skill',
    runs,
    days: runs,
    sessions: runs,
    first_day: '2026-06-01',
    last_day: lastDay,
    with_args: 0,
  };
}

describe('rankCommands', () => {
  it('ranks by run count, most-used first', () => {
    const rows = rankCommands(record({ commands: [cmd('terra', 3), cmd('spark', 9)] }), '2026-08-27');
    expect(rows.map((r) => r.name)).toEqual(['spark', 'terra']);
  });

  it('breaks a tie alphabetically so the order is stable between reloads', () => {
    const rows = rankCommands(record({ commands: [cmd('wick', 2), cmd('quill', 2)] }), '2026-08-27');
    expect(rows.map((r) => r.name)).toEqual(['quill', 'wick']);
  });

  it('keeps never-run commands in the same list, after the used ones', () => {
    const rows = rankCommands(
      record({ commands: [cmd('spark', 9)], cold: ['twins', 'burn'] }),
      '2026-08-27',
    );
    expect(rows.map((r) => r.name)).toEqual(['spark', 'burn', 'twins']);
    expect(rows[1]).toMatchObject({ runs: 0, lastDay: null, staleDays: null });
  });

  it('measures staleness from the last day it ran', () => {
    const rows = rankCommands(record({ commands: [cmd('spark', 1, '2026-08-20')] }), '2026-08-27');
    expect(rows[0].staleDays).toBe(7);
  });

  it('survives an empty record', () => {
    expect(rankCommands(null, '2026-08-27')).toEqual([]);
    expect(rankCommands(record(), '2026-08-27')).toEqual([]);
  });
});

describe('daysBetween', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween('2026-07-30', '2026-08-02')).toBe(3);
  });

  it('returns 0 rather than NaN for junk', () => {
    expect(daysBetween('', '2026-08-02')).toBe(0);
  });
});

describe('staleLabel', () => {
  it('names the near past in words and the far past in units', () => {
    expect(staleLabel(0)).toBe('today');
    expect(staleLabel(1)).toBe('yesterday');
    expect(staleLabel(5)).toBe('5d');
    expect(staleLabel(21)).toBe('3w');
    expect(staleLabel(90)).toBe('3mo');
  });

  it('says never, not "0d", for a command that has no last day', () => {
    expect(staleLabel(null)).toBe('never');
  });
});

describe('peakHour', () => {
  it('finds the busiest hour', () => {
    expect(peakHour(record({ by_hour: [{ hour: 9, runs: 2 }, { hour: 22, runs: 7 }] }))).toBe(22);
  });

  it('is null when nothing has run, so the caller can stay quiet', () => {
    expect(peakHour(record({ by_hour: [{ hour: 9, runs: 0 }] }))).toBeNull();
    expect(peakHour(null)).toBeNull();
  });
});

describe('hourLabel', () => {
  it('reads as a clock, not a number', () => {
    expect([0, 9, 12, 13, 23].map(hourLabel)).toEqual(['12a', '9a', '12p', '1p', '11p']);
  });
});
