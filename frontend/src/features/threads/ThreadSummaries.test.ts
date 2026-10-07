import { describe, expect, it } from 'vitest';
import { authorLabel, sourceDays, statusLabel } from './ThreadSummaries';

describe('sourceDays', () => {
  it('turns a mix of card ids and bare days into each day once, in order', () => {
    expect(
      sourceDays(['2026-03-10.0910b', '2026-03-08', '2026-03-10.0900b', '2026-03-12.0900b2']),
    ).toEqual(['2026-03-08', '2026-03-10', '2026-03-12']);
  });
});

describe('authorLabel', () => {
  it('names the keeper and any cricket in plain words', () => {
    expect(authorLabel('keeper')).toBe('Keeper');
    expect(authorLabel('cricket:thread-helper')).toBe('Cricket');
  });
});

describe('statusLabel', () => {
  it('marks only a summary written for a status change', () => {
    expect(statusLabel(null)).toBeNull();
    expect(statusLabel('retired')).toBe('retired');
    expect(statusLabel('active')).toBe('active again');
  });
});
