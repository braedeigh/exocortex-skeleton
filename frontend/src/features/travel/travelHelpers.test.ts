import { describe, expect, it } from 'vitest';
import {
  dateRange,
  filterSuggestions,
  nextStatus,
  progressLine,
  splitTrips,
  tripHasItem,
  tripProgress,
} from './travelHelpers';
import type { Trip, TripItem } from './types';

function item(over: Partial<TripItem>): TripItem {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    name: 'thing',
    source: 'text',
    ref_id: '',
    category: '',
    notes: '',
    packed: false,
    returned: '',
    ...over,
  };
}

function trip(over: Partial<Trip>): Trip {
  return {
    id: 't1',
    name: 'Denver',
    destination: '',
    start: '',
    end: '',
    status: 'planning',
    notes: '',
    items: [],
    created_at: '2026-07-01',
    ...over,
  };
}

describe('nextStatus', () => {
  it('advances through the lifecycle and stops at home', () => {
    expect(nextStatus('planning')).toBe('packing');
    expect(nextStatus('packing')).toBe('away');
    expect(nextStatus('away')).toBe('home');
    expect(nextStatus('home')).toBeNull();
  });
});

describe('splitTrips', () => {
  it('separates past trips and sorts current soonest-first', () => {
    const trips = [
      trip({ id: 'a', start: '2026-09-01' }),
      trip({ id: 'b', start: '2026-08-01' }),
      trip({ id: 'c', status: 'home', start: '2026-01-01' }),
      trip({ id: 'd', status: 'home', start: '2026-06-01' }),
      trip({ id: 'e', start: '', created_at: '' }), // fully undated sorts last among current
    ];
    const { current, past } = splitTrips(trips);
    expect(current.map((t) => t.id)).toEqual(['b', 'a', 'e']);
    expect(past.map((t) => t.id)).toEqual(['d', 'c']);
  });

  it('falls back to created_at when start is unset', () => {
    const { current } = splitTrips([
      trip({ id: 'a', created_at: '2026-07-10' }),
      trip({ id: 'b', created_at: '2026-07-01' }),
    ]);
    expect(current.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('tripProgress / progressLine', () => {
  it('counts the reckoning over packed items only', () => {
    const t = trip({
      status: 'home',
      items: [
        item({ packed: true, returned: 'home' }),
        item({ packed: true, returned: 'left' }),
        item({ packed: true, returned: '' }),
        item({ packed: false }), // never packed — not part of the reckoning
      ],
    });
    const p = tripProgress(t);
    expect(p).toMatchObject({ total: 4, packed: 3, home: 1, left: 1, lost: 0, unresolved: 1 });
    expect(progressLine(t)).toBe('1/3 home · 1 left · 1 unresolved');
  });

  it('shows packing progress before departure', () => {
    const t = trip({
      status: 'packing',
      items: [item({ packed: true }), item({ packed: false })],
    });
    expect(progressLine(t)).toBe('1/2 packed');
  });
});

describe('filterSuggestions', () => {
  const sources = {
    sources: {
      archivals: [
        { id: 'a1', name: 'Chacos', category: 'clothing', photo: 'chacos.png' },
        { id: 'a2', name: 'Boonie hat', category: 'clothing', photo: '' },
      ],
      active: [{ id: 'Vitamin D', name: 'Vitamin D', category: 'supplements', photo: '' }],
    },
  };

  it('matches by name or category, excluding items already on the trip', () => {
    const t = trip({
      items: [item({ name: 'Chacos', source: 'archival', ref_id: 'a1' })],
    });
    expect(filterSuggestions(sources, t, 'cha').map((s) => s.name)).toEqual([]);
    expect(filterSuggestions(sources, t, 'clothing').map((s) => s.name)).toEqual(['Boonie hat']);
    expect(filterSuggestions(sources, t, 'vita').map((s) => s.name)).toEqual(['Vitamin D']);
  });

  it('returns nothing for a blank query', () => {
    expect(filterSuggestions(sources, trip({}), '  ')).toEqual([]);
  });
});

describe('tripHasItem', () => {
  it('matches referenced items by ref and free text by name, case-insensitively', () => {
    const t = trip({
      items: [
        item({ name: 'Chacos', source: 'archival', ref_id: 'a1' }),
        item({ name: 'Toothbrush' }),
      ],
    });
    expect(tripHasItem(t, 'archival', 'a1', 'renamed display name')).toBe(true);
    expect(tripHasItem(t, 'text', '', ' TOOTHBRUSH ')).toBe(true);
    expect(tripHasItem(t, 'archival', 'a2', 'Chacos')).toBe(false);
  });
});

describe('dateRange', () => {
  it('formats start–end, open-ended, and empty', () => {
    expect(dateRange(trip({ start: '2026-08-01', end: '2026-08-09' }))).toBe('Aug 1 – Aug 9');
    expect(dateRange(trip({ start: '2026-08-01' }))).toBe('Aug 1 →');
    expect(dateRange(trip({}))).toBe('');
  });
});
