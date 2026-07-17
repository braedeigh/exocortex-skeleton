/**
 * travelHelpers.ts — pure logic for the Travel page: trip grouping, packing /
 * reckoning progress, the add-item suggestion search, and the cache patchers
 * the optimistic mutations use. No React, fully unit-testable.
 */

import type {
  ItemSource,
  SourceItem,
  TravelData,
  Trip,
  TripItem,
  TripStatus,
} from './types';

// --- trip lifecycle ---

export const STATUS_LABEL: Record<TripStatus, string> = {
  planning: 'Planning',
  packing: 'Packing',
  away: 'Away',
  home: 'Home',
};

const STATUS_ORDER: TripStatus[] = ['planning', 'packing', 'away', 'home'];

/** The forward step in the trip lifecycle, or null once home. */
export function nextStatus(status: TripStatus): TripStatus | null {
  const i = STATUS_ORDER.indexOf(status);
  return i >= 0 && i < STATUS_ORDER.length - 1 ? STATUS_ORDER[i + 1] : null;
}

export const NEXT_STATUS_LABEL: Record<TripStatus, string> = {
  planning: 'Start packing',
  packing: 'Head out',
  away: 'Back home — unpack',
  home: '',
};

/** Current trips (planning/packing/away) soonest-first, past trips (home)
 * most recent first. Undated trips sort after dated ones in both groups. */
export function splitTrips(trips: Trip[]): { current: Trip[]; past: Trip[] } {
  const key = (t: Trip) => t.start || t.created_at || '';
  const current = trips
    .filter((t) => t.status !== 'home')
    .sort((a, b) => (key(a) || '9999').localeCompare(key(b) || '9999'));
  const past = trips
    .filter((t) => t.status === 'home')
    .sort((a, b) => key(b).localeCompare(key(a)));
  return { current, past };
}

// --- progress ---

export interface TripProgress {
  total: number;
  packed: number;
  home: number;
  left: number;
  lost: number;
  /** Packed items with no unpack verdict yet — the reckoning's to-do. */
  unresolved: number;
}

export function tripProgress(trip: Trip): TripProgress {
  const items = trip.items ?? [];
  const packed = items.filter((i) => i.packed);
  return {
    total: items.length,
    packed: packed.length,
    home: packed.filter((i) => i.returned === 'home').length,
    left: packed.filter((i) => i.returned === 'left').length,
    lost: packed.filter((i) => i.returned === 'lost').length,
    unresolved: packed.filter((i) => i.returned === '').length,
  };
}

/** One line for the card header: packing progress before the trip, the
 * reckoning tally once it's away/home. */
export function progressLine(trip: Trip): string {
  const p = tripProgress(trip);
  if (p.total === 0) return 'no items yet';
  if (trip.status === 'planning' || trip.status === 'packing') {
    return `${p.packed}/${p.total} packed`;
  }
  const parts = [`${p.home}/${p.packed} home`];
  if (p.left) parts.push(`${p.left} left`);
  if (p.lost) parts.push(`${p.lost} lost`);
  if (p.unresolved) parts.push(`${p.unresolved} unresolved`);
  return parts.join(' · ');
}

// --- add-item suggestions ---

export interface Suggestion extends SourceItem {
  source: ItemSource;
}

/** Duplicate identity, mirroring routes/travel.py's _item_key. */
function itemKey(source: ItemSource, refId: string, name: string): string {
  if (source !== 'text' && refId) return `${source}:${refId}`;
  return `text:${name.trim().toLowerCase()}`;
}

export function tripHasItem(trip: Trip, source: ItemSource, refId: string, name: string): boolean {
  return (trip.items ?? []).some(
    (i) => itemKey(i.source, i.ref_id, i.name) === itemKey(source, refId, name),
  );
}

/** Sources matching the query that aren't already on the trip — archival
 * matches first (they're the interesting ones), then consumables. */
export function filterSuggestions(
  data: Pick<TravelData, 'sources'>,
  trip: Trip,
  query: string,
  limit = 8,
): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pool: Suggestion[] = [
    ...data.sources.archivals.map((s) => ({ ...s, source: 'archival' as const })),
    ...data.sources.active.map((s) => ({ ...s, source: 'active' as const })),
  ];
  return pool
    .filter(
      (s) =>
        (s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)) &&
        !tripHasItem(trip, s.source, s.id, s.name),
    )
    .slice(0, limit);
}

// --- optimistic cache patchers ---

export function patchTrip(data: TravelData, tripId: string, patch: Partial<Trip>): TravelData {
  return {
    ...data,
    trips: data.trips.map((t) => (t.id === tripId ? { ...t, ...patch } : t)),
  };
}

export function patchItem(
  data: TravelData,
  tripId: string,
  itemId: string,
  patch: Partial<TripItem>,
): TravelData {
  return {
    ...data,
    trips: data.trips.map((t) =>
      t.id === tripId
        ? { ...t, items: t.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }
        : t,
    ),
  };
}

export function appendItem(data: TravelData, tripId: string, item: TripItem): TravelData {
  return {
    ...data,
    trips: data.trips.map((t) => (t.id === tripId ? { ...t, items: [...t.items, item] } : t)),
  };
}

export function dropItem(data: TravelData, tripId: string, itemId: string): TravelData {
  return {
    ...data,
    trips: data.trips.map((t) =>
      t.id === tripId ? { ...t, items: t.items.filter((i) => i.id !== itemId) } : t,
    ),
  };
}

export function dropTrip(data: TravelData, tripId: string): TravelData {
  return { ...data, trips: data.trips.filter((t) => t.id !== tripId) };
}

// --- misc display ---

/** "Aug 1 – Aug 9" / "Aug 1 →" / '' — tolerant of missing ends. */
export function dateRange(trip: Trip): string {
  const fmt = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
  };
  if (trip.start && trip.end) return `${fmt(trip.start)} – ${fmt(trip.end)}`;
  if (trip.start) return `${fmt(trip.start)} →`;
  return '';
}
