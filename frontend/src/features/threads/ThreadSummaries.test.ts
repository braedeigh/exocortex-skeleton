import { describe, expect, it } from 'vitest';
import { authorLabel, sourceDays } from './ThreadSummaries';

describe('sourceDays', () => {
  it('turns a mix of card ids and bare days into each day once, in order', () => {
    expect(
      sourceDays(['2026-07-13.2220b', '2026-06-26', '2026-07-13.2218b', '2026-10-02.2043b2']),
    ).toEqual(['2026-06-26', '2026-07-13', '2026-10-02']);
  });
});

describe('authorLabel', () => {
  it('names the keeper and any cricket in plain words', () => {
    expect(authorLabel('keeper')).toBe('Keeper');
    expect(authorLabel('cricket:thread-helper')).toBe('Cricket');
  });
});
