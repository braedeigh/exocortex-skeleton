/**
 * filters.ts — pure filtering logic behind the Flow lane's chip row
 * (FlowLane.tsx). GET /api/observatory/flow (routes/terrain.py) now tags
 * every event with "place" (which broad kind of file — journal, threads,
 * research, data, docs, code, other) and "fronts" (life-domain tags); this
 * module turns a selection on those two axes into a filtered event list, and
 * persists the selection the same way ThreadsDirectory.tsx persists its sort
 * mode: a small localStorage read/write pair, storage-blocked errors
 * swallowed rather than thrown.
 *
 * The rule (her call): chips selected within ONE axis union (show an event
 * matching ANY selected place); chips selected across the TWO axes
 * intersect (an event must match the place selection AND the front
 * selection). An axis with nothing selected imposes no constraint.
 */
import type { FlowEvent } from './api';

/** Fixed left-to-right order for place chips — matches the plain-English
 * order in terrain.py's _flow_place table (journal is the closest-to-her
 * place, code the furthest). Chips only render for a place actually present
 * in the current window (see visiblePlaces), so this is a display order, not
 * a claim that every one of these shows up. */
export const PLACE_ORDER = ['journal', 'threads', 'research', 'data', 'docs', 'code', 'other'] as const;
export type Place = (typeof PLACE_ORDER)[number];

export const PLACE_LABEL: Record<Place, string> = {
  journal: 'Journal',
  threads: 'Threads',
  research: 'Research',
  data: 'Data',
  docs: 'Docs',
  code: 'Code',
  other: 'Other',
};

export interface FlowFilters {
  places: string[];
  fronts: string[];
}

export const EMPTY_FLOW_FILTERS: FlowFilters = { places: [], fronts: [] };

export interface FlowChip {
  id: string;
  count: number;
}

/** Event counts per place/front in the given window — the chip row's counts
 * are always "in what's on screen right now", not lifetime totals. */
export function countsByPlace(events: FlowEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.place] = (out[e.place] ?? 0) + 1;
  return out;
}

export function countsByFront(events: FlowEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    for (const f of e.fronts) out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

/** Place chips to render: PLACE_ORDER filtered to places present in the
 * window, PLUS any place currently selected even if its count just dropped
 * to 0 — so toggling a chip off is always possible, a selection can never
 * become unremovable just because the window moved on. */
export function visiblePlaces(events: FlowEvent[], selected: string[]): FlowChip[] {
  const counts = countsByPlace(events);
  const present = new Set<string>([...Object.keys(counts), ...selected]);
  return PLACE_ORDER.filter((p) => present.has(p)).map((p) => ({ id: p, count: counts[p] ?? 0 }));
}

/** Front chips to render: every front present in the window, plus any
 * currently-selected front even at a dropped-to-0 count (same reasoning as
 * visiblePlaces). Alphabetical — fronts have no fixed narrative order the
 * way places do. */
export function visibleFronts(events: FlowEvent[], selected: string[]): FlowChip[] {
  const counts = countsByFront(events);
  const present = new Set<string>([...Object.keys(counts), ...selected]);
  return Array.from(present)
    .sort()
    .map((f) => ({ id: f, count: counts[f] ?? 0 }));
}

/** The two-axis filter itself: union within an axis, intersection across
 * the two. No selection on either axis at all -> everything shows. */
export function applyFlowFilters(events: FlowEvent[], filters: FlowFilters): FlowEvent[] {
  const { places, fronts } = filters;
  if (places.length === 0 && fronts.length === 0) return events;
  return events.filter((e) => {
    const placeOk = places.length === 0 || places.includes(e.place);
    const frontOk = fronts.length === 0 || e.fronts.some((f) => fronts.includes(f));
    return placeOk && frontOk;
  });
}

/** Add/remove one value from a selection list — the chip tap handler. */
export function toggleChip(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id];
}

const STORAGE_KEY = 'flow-filters';

export function readFlowFilters(): FlowFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { places: [], fronts: [] };
    const parsed = JSON.parse(raw);
    const places = Array.isArray(parsed?.places) ? parsed.places.filter((p: unknown) => typeof p === 'string') : [];
    const fronts = Array.isArray(parsed?.fronts) ? parsed.fronts.filter((f: unknown) => typeof f === 'string') : [];
    return { places, fronts };
  } catch {
    // storage blocked or malformed — fall through to no filters
  }
  return { places: [], fronts: [] };
}

export function writeFlowFilters(filters: FlowFilters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // storage full/blocked — the selection just won't persist
  }
}
