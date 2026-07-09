import { describe, expect, it } from 'vitest';
import {
  collectCustomTypes,
  entryTagSummary,
  formatEntryDate,
  medSlug,
  medTypeLabel,
  sortEntries,
} from './practiceHelpers';
import type { MeditationEntry } from './types';

describe('medTypeLabel', () => {
  it('maps builtin slugs to their labels', () => {
    expect(medTypeLabel('sitting')).toBe('Sitting');
    expect(medTypeLabel('deity_yoga')).toBe('Deity yoga');
  });

  it('title-cases unknown slugs, underscores as spaces', () => {
    expect(medTypeLabel('tonglen')).toBe('Tonglen');
    expect(medTypeLabel('open_awareness')).toBe('Open Awareness');
  });

  it('falls back to an em dash for empty input', () => {
    expect(medTypeLabel('')).toBe('—');
    expect(medTypeLabel(null)).toBe('—');
  });
});

describe('medSlug', () => {
  it('lowercases and collapses non-alphanumerics to underscores', () => {
    expect(medSlug('  Tonglen! ')).toBe('tonglen');
    expect(medSlug('Open Awareness (sky)')).toBe('open_awareness_sky');
  });

  it('strips leading/trailing underscores and handles empty input', () => {
    expect(medSlug('***')).toBe('');
    expect(medSlug('')).toBe('');
    expect(medSlug(null)).toBe('');
  });
});

describe('formatEntryDate', () => {
  it('formats an ISO date with weekday, avoiding UTC day-shift', () => {
    expect(formatEntryDate('2026-07-09')).toBe('Thu, Jul 9, 2026');
  });

  it('says "undated" for missing dates and passes garbage through', () => {
    expect(formatEntryDate(null)).toBe('undated');
    expect(formatEntryDate('')).toBe('undated');
    expect(formatEntryDate('not-a-date')).toBe('not-a-date');
  });
});

describe('sortEntries', () => {
  it('sorts by date desc, id desc as tiebreaker, undated last', () => {
    const entries: MeditationEntry[] = [
      { id: 'a', date: '2026-07-01' },
      { id: 'b', date: null },
      { id: 'c', date: '2026-07-09' },
      { id: 'd', date: '2026-07-09' },
    ];
    expect(sortEntries(entries).map((e) => e.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('does not mutate the input', () => {
    const entries: MeditationEntry[] = [
      { id: 'a', date: '2026-07-01' },
      { id: 'b', date: '2026-07-09' },
    ];
    sortEntries(entries);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('collectCustomTypes', () => {
  it('collects non-builtin tags from entries plus session extras, sorted, deduped', () => {
    const entries: MeditationEntry[] = [
      { id: 'a', types: ['sitting', 'tonglen'] },
      { id: 'b', types: ['zazen', 'tonglen'] },
      { id: 'c' },
    ];
    expect(collectCustomTypes(entries, ['ngondro', 'zazen'])).toEqual(['ngondro', 'tonglen', 'zazen']);
  });

  it('excludes every builtin type', () => {
    const entries: MeditationEntry[] = [
      { id: 'a', types: ['sitting', 'walking', 'deity_yoga', 'metta', 'vipassana'] },
    ];
    expect(collectCustomTypes(entries, [])).toEqual([]);
  });
});

describe('entryTagSummary', () => {
  it('joins labels with " + "', () => {
    expect(entryTagSummary({ id: 'a', types: ['sitting', 'tonglen'] })).toBe('Sitting + Tonglen');
  });

  it('falls back to "cell" when untagged', () => {
    expect(entryTagSummary({ id: 'a' })).toBe('cell');
    expect(entryTagSummary({ id: 'a', types: [] })).toBe('cell');
  });
});
