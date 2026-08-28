import { describe, expect, it } from 'vitest';
import {
  applyEntryAdd,
  applyEntryRemove,
  applyNotesText,
  carTypeLabel,
  daysUntil,
  dueTone,
  localTodayISO,
  normalizeNewEntry,
  sortEntriesByNextDue,
} from './carMath';
import type { CarData, CarEntry } from './types';

const TODAY = '2026-07-09';

function entry(overrides: Partial<CarEntry> = {}): CarEntry {
  return {
    id: 'e1',
    type: 'oil_change',
    date: '2026-06-01',
    mileage: null,
    notes: '',
    next_due: null,
    ...overrides,
  };
}

describe('carTypeLabel', () => {
  it('uses the canonical label for known types', () => {
    expect(carTypeLabel('oil_change')).toBe('Oil change');
    expect(carTypeLabel('brake_pads')).toBe('Brake pads');
    expect(carTypeLabel('registration')).toBe('Registration');
  });

  it('humanizes custom snake_case types', () => {
    expect(carTypeLabel('tire_rotation')).toBe('Tire Rotation');
    expect(carTypeLabel('other')).toBe('Other');
  });

  it('falls back to an em dash for empty types', () => {
    expect(carTypeLabel('')).toBe('—');
    expect(carTypeLabel(null)).toBe('—');
    expect(carTypeLabel(undefined)).toBe('—');
  });
});

describe('daysUntil', () => {
  it('is null when there is no date', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('', TODAY)).toBeNull();
  });

  it('is null for garbage dates', () => {
    expect(daysUntil('not-a-date', TODAY)).toBeNull();
  });

  it('is 0 for today', () => {
    expect(daysUntil(TODAY, TODAY)).toBe(0);
  });

  it('is negative for past dates', () => {
    expect(daysUntil('2026-07-01', TODAY)).toBe(-8);
  });

  it('counts forward across month boundaries', () => {
    expect(daysUntil('2026-08-08', TODAY)).toBe(30);
    expect(daysUntil('2026-08-09', TODAY)).toBe(31);
  });
});

describe('dueTone', () => {
  it('is null when there is no due date', () => {
    expect(dueTone(null)).toBeNull();
  });

  it('is overdue below zero days', () => {
    expect(dueTone(-1)).toBe('overdue');
  });

  it('is soon from 0 through 30 days', () => {
    expect(dueTone(0)).toBe('soon');
    expect(dueTone(30)).toBe('soon');
  });

  it('is unstyled past 30 days', () => {
    expect(dueTone(31)).toBeNull();
  });
});

describe('sortEntriesByNextDue', () => {
  it('sorts soonest due first with undated entries last', () => {
    const list = [
      entry({ id: 'a', next_due: null }),
      entry({ id: 'b', next_due: '2026-09-01' }),
      entry({ id: 'c', next_due: '2026-07-15' }),
    ];
    expect(sortEntriesByNextDue(list).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input', () => {
    const list = [entry({ id: 'a', next_due: '2026-09-01' }), entry({ id: 'b', next_due: '2026-07-15' })];
    sortEntriesByNextDue(list);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('localTodayISO', () => {
  it('formats the local calendar date with zero padding', () => {
    expect(localTodayISO(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('normalizeNewEntry', () => {
  it('mirrors the server: trims, "other" fallback, blanks to null', () => {
    const e = normalizeNewEntry(
      { type: '  ', date: '', mileage: '', notes: '  fresh pads ', next_due: '2026-10-01' },
      'tmp-1',
    );
    expect(e).toEqual({
      id: 'tmp-1',
      type: 'other',
      date: null,
      mileage: null,
      notes: 'fresh pads',
      next_due: '2026-10-01',
    });
  });

  it('keeps mileage as the posted string when present', () => {
    const e = normalizeNewEntry(
      { type: 'oil_change', date: '2026-07-09', mileage: '87500', notes: '', next_due: '' },
      'tmp-2',
    );
    expect(e.mileage).toBe('87500');
    expect(e.next_due).toBeNull();
  });
});

describe('optimistic cache updaters', () => {
  const base: CarData = {
    server_date: TODAY,
    car_maintenance: { entries: [entry({ id: 'a' }), entry({ id: 'b' })] },
    car_notes: { text: 'old' },
  };

  it('applyEntryAdd appends without mutating the previous data', () => {
    const next = applyEntryAdd(base, entry({ id: 'c' }));
    expect(next.car_maintenance?.entries?.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(base.car_maintenance?.entries).toHaveLength(2);
  });

  it('applyEntryAdd tolerates a missing entries list', () => {
    const next = applyEntryAdd({}, entry({ id: 'c' }));
    expect(next.car_maintenance?.entries?.map((e) => e.id)).toEqual(['c']);
  });

  it('applyEntryRemove drops only the matching id', () => {
    const next = applyEntryRemove(base, 'a');
    expect(next.car_maintenance?.entries?.map((e) => e.id)).toEqual(['b']);
    expect(base.car_maintenance?.entries).toHaveLength(2);
  });

  it('applyNotesText replaces the notepad text', () => {
    expect(applyNotesText(base, 'new').car_notes?.text).toBe('new');
    expect(base.car_notes?.text).toBe('old');
  });
});
