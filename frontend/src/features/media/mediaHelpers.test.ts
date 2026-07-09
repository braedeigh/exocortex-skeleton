import { describe, expect, it } from 'vitest';
import {
  countByType,
  formatMediaDate,
  mediaTypeLabel,
  presentMediaTypes,
  todayStr,
  visibleMediaItems,
} from './mediaHelpers';
import type { MediaFilterState, MediaItem } from './types';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return { id: 'a', title: 'A Thing', type: 'book', ...overrides };
}

function filter(overrides: Partial<MediaFilterState> = {}): MediaFilterState {
  return { type: 'all', sort: 'date', query: '', ...overrides };
}

const ids = (items: MediaItem[]) => items.map((it) => it.id);

describe('mediaTypeLabel', () => {
  it('labels known types', () => {
    expect(mediaTypeLabel('book')).toBe('📖 Book');
    expect(mediaTypeLabel('podcast')).toBe('🎧 Podcast');
  });
  it('falls back to Other for unknown or missing types', () => {
    expect(mediaTypeLabel('zine')).toBe('✦ Other');
    expect(mediaTypeLabel(undefined)).toBe('✦ Other');
  });
});

describe('formatMediaDate', () => {
  it('formats ISO dates as "Mon D, YYYY"', () => {
    expect(formatMediaDate('2026-07-04')).toBe('Jul 4, 2026');
  });
  it('says undated when missing', () => {
    expect(formatMediaDate(null)).toBe('undated');
    expect(formatMediaDate('')).toBe('undated');
  });
  it('passes unparseable input through untouched', () => {
    expect(formatMediaDate('whenever')).toBe('whenever');
  });
});

describe('todayStr', () => {
  it('is a local YYYY-MM-DD string', () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('presentMediaTypes', () => {
  it('returns only types present, in canonical order', () => {
    const items = [item({ type: 'game' }), item({ type: 'book' }), item({ type: 'game' })];
    expect(presentMediaTypes(items)).toEqual(['book', 'game']);
  });
  it('ignores unknown types', () => {
    expect(presentMediaTypes([item({ type: 'zine' })])).toEqual([]);
  });
});

describe('countByType', () => {
  it('counts exact type matches', () => {
    const items = [item({ type: 'book' }), item({ type: 'book' }), item({ type: 'show' })];
    expect(countByType(items, 'book')).toBe(2);
    expect(countByType(items, 'movie')).toBe(0);
  });
});

describe('visibleMediaItems — filtering', () => {
  const items = [
    item({ id: '1', type: 'book', title: 'Piranesi', author: 'Susanna Clarke' }),
    item({ id: '2', type: 'movie', title: 'Arrival' }),
    item({ id: '3', type: 'book', title: 'The Dispossessed', author: 'Ursula K. Le Guin' }),
  ];

  it('type filter keeps only that type', () => {
    expect(ids(visibleMediaItems(items, filter({ type: 'movie' })))).toEqual(['2']);
  });

  it("'all' keeps everything", () => {
    expect(visibleMediaItems(items, filter())).toHaveLength(3);
  });

  it('search matches title case-insensitively', () => {
    expect(ids(visibleMediaItems(items, filter({ query: 'piran' })))).toEqual(['1']);
    expect(ids(visibleMediaItems(items, filter({ query: 'ARRIVAL' })))).toEqual(['2']);
  });

  it('search matches author too', () => {
    expect(ids(visibleMediaItems(items, filter({ query: 'le guin' })))).toEqual(['3']);
  });

  it('search ignores surrounding whitespace and does not match notes', () => {
    const withNotes = [...items.slice(0, 1), item({ id: '9', title: 'X', notes: 'piranesi-ish' })];
    expect(ids(visibleMediaItems(withNotes, filter({ query: '  piran  ' })))).toEqual(['1']);
  });

  it('applies type filter and search together', () => {
    expect(ids(visibleMediaItems(items, filter({ type: 'book', query: 'the' })))).toEqual(['3']);
  });
});

describe('visibleMediaItems — sorting', () => {
  it('puts not-done before done regardless of sort mode', () => {
    const items = [
      item({ id: 'd', done: true, date: '2026-07-09' }),
      item({ id: 'n', done: false, date: '2020-01-01' }),
    ];
    for (const sort of ['date', 'title', 'type'] as const) {
      expect(ids(visibleMediaItems(items, filter({ sort })))[0]).toBe('n');
    }
  });

  it('date mode sorts date desc, undated last, id desc as tiebreak', () => {
    const items = [
      item({ id: 'old', date: '2025-01-01' }),
      item({ id: 'none', date: null }),
      item({ id: 'new', date: '2026-06-30' }),
      item({ id: 'b-same', date: '2026-06-30' }),
    ];
    expect(ids(visibleMediaItems(items, filter()))).toEqual(['new', 'b-same', 'old', 'none']);
  });

  it('title mode sorts alphabetically, case-insensitive', () => {
    const items = [
      item({ id: '1', title: 'zebra' }),
      item({ id: '2', title: 'Apple' }),
      item({ id: '3', title: 'mango' }),
    ];
    expect(ids(visibleMediaItems(items, filter({ sort: 'title' })))).toEqual(['2', '3', '1']);
  });

  it('type mode groups by type label and falls back to date desc within a group', () => {
    const items = [
      item({ id: 'b-old', type: 'book', date: '2025-01-01' }),
      item({ id: 'm', type: 'movie', date: '2026-01-01' }),
      item({ id: 'b-new', type: 'book', date: '2026-05-05' }),
    ];
    const sorted = visibleMediaItems(items, filter({ sort: 'type' }));
    const types = sorted.map((it) => it.type);
    // items of the same type are contiguous
    expect(types.filter((t) => t === 'book')).toHaveLength(2);
    expect(types.indexOf('book') + 1).toBe(types.lastIndexOf('book'));
    // within the book group, newer first
    const books = sorted.filter((it) => it.type === 'book');
    expect(ids(books)).toEqual(['b-new', 'b-old']);
  });

  it('does not mutate the input array', () => {
    const items = [item({ id: '2', date: '2026-01-02' }), item({ id: '1', date: '2026-01-03' })];
    const before = ids(items);
    visibleMediaItems(items, filter());
    expect(ids(items)).toEqual(before);
  });
});
