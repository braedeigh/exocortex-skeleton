import { describe, expect, it } from 'vitest';
import {
  HOUSING_STATUSES,
  STATUS_OPTIONS,
  isHousingStatus,
  normalizeStatus,
  sortEntriesForDisplay,
  statusColorVar,
  statusRank,
} from './statusLadder';

describe('STATUS_OPTIONS', () => {
  it('follows the ladder order with plain labels except GOT IT', () => {
    expect(STATUS_OPTIONS.map((o) => o.value)).toEqual([...HOUSING_STATUSES]);
    expect(STATUS_OPTIONS.map((o) => o.label)).toEqual([
      'found',
      'contacted',
      'touring',
      'toured',
      'applied',
      'passed',
      'GOT IT',
    ]);
  });
});

describe('isHousingStatus / normalizeStatus', () => {
  it('accepts every ladder value', () => {
    for (const s of HOUSING_STATUSES) {
      expect(isHousingStatus(s)).toBe(true);
      expect(normalizeStatus(s)).toBe(s);
    }
  });

  it('collapses unknown, empty and missing values to found', () => {
    expect(normalizeStatus('lost')).toBe('found');
    expect(normalizeStatus('')).toBe('found');
    expect(normalizeStatus(null)).toBe('found');
    expect(normalizeStatus(undefined)).toBe('found');
  });

  it('rejects non-ladder values', () => {
    expect(isHousingStatus('GOT IT')).toBe(false);
    expect(isHousingStatus(3)).toBe(false);
  });
});

describe('statusColorVar', () => {
  it('maps each status to its theme accent', () => {
    expect(statusColorVar('found')).toBe('var(--text-muted)');
    expect(statusColorVar('contacted')).toBe('var(--text)');
    expect(statusColorVar('touring')).toBe('var(--ongoing)');
    expect(statusColorVar('toured')).toBe('var(--ongoing)');
    expect(statusColorVar('applied')).toBe('var(--orange)');
    expect(statusColorVar('passed')).toBe('var(--red)');
    expect(statusColorVar('got_it')).toBe('var(--green)');
  });

  it('falls back to muted for unknown values', () => {
    expect(statusColorVar('lost')).toBe('var(--text-muted)');
    expect(statusColorVar(undefined)).toBe('var(--text-muted)');
  });
});

describe('statusRank / sortEntriesForDisplay', () => {
  it('pins got_it to the top and sinks passed', () => {
    const entries = [
      { id: 'a', status: 'passed' },
      { id: 'b', status: 'found' },
      { id: 'c', status: 'got_it' },
      { id: 'd', status: 'applied' },
      { id: 'e', status: 'contacted' },
      { id: 'f', status: 'touring' },
      { id: 'g', status: 'toured' },
    ];
    expect(sortEntriesForDisplay(entries).map((e) => e.id)).toEqual([
      'c', // got_it
      'd', // applied
      'g', // toured
      'f', // touring
      'e', // contacted
      'b', // found
      'a', // passed
    ]);
  });

  it('ranks unknown statuses after everything, even passed', () => {
    expect(statusRank('???')).toBeGreaterThan(statusRank('passed'));
    const sorted = sortEntriesForDisplay([
      { id: 'x', status: 'mystery' },
      { id: 'y', status: 'passed' },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['y', 'x']);
  });

  it('keeps insertion order within the same status (stable)', () => {
    const sorted = sortEntriesForDisplay([
      { id: 'first', status: 'found' },
      { id: 'top', status: 'got_it' },
      { id: 'second', status: 'found' },
      { id: 'third', status: 'found' },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['top', 'first', 'second', 'third']);
  });

  it('does not mutate the input array', () => {
    const entries = [
      { id: 'a', status: 'passed' },
      { id: 'b', status: 'got_it' },
    ];
    sortEntriesForDisplay(entries);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
