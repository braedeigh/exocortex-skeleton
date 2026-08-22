import { describe, expect, it } from 'vitest';
import {
  applyFlowFilters,
  countsByFront,
  countsByPlace,
  toggleChip,
  visibleFronts,
  visiblePlaces,
  type FlowFilters,
} from './filters';
import type { FlowEvent } from './api';

function event(over: Partial<FlowEvent> = {}): FlowEvent {
  return {
    id: 'conv:0',
    conv: 'conv',
    title: 'Session',
    bot: null,
    running: false,
    repo: 'skeleton',
    path: 'app.py',
    kind: 'edit',
    place: 'code',
    fronts: [],
    ts: null,
    epoch: 0,
    snippet: null,
    snippet_total_lines: 0,
    ...over,
  };
}

describe('applyFlowFilters', () => {
  const events = [
    event({ id: 'a', place: 'journal', fronts: ['health'] }),
    event({ id: 'b', place: 'threads', fronts: ['connection'] }),
    event({ id: 'c', place: 'code', fronts: ['health', 'exocortex'] }),
    event({ id: 'd', place: 'code', fronts: [] }),
  ];

  it('shows everything when no filter is selected', () => {
    const filters: FlowFilters = { places: [], fronts: [] };
    expect(applyFlowFilters(events, filters).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('unions multiple selections within one axis (place)', () => {
    const filters: FlowFilters = { places: ['journal', 'threads'], fronts: [] };
    expect(applyFlowFilters(events, filters).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('unions multiple selections within one axis (front)', () => {
    const filters: FlowFilters = { places: [], fronts: ['health', 'connection'] };
    expect(applyFlowFilters(events, filters).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('intersects selections across the two axes', () => {
    // place=code (c, d) AND front=health (a, c) -> only c matches both
    const filters: FlowFilters = { places: ['code'], fronts: ['health'] };
    expect(applyFlowFilters(events, filters).map((e) => e.id)).toEqual(['c']);
  });

  it('an event with no fronts never matches a front selection', () => {
    const filters: FlowFilters = { places: [], fronts: ['health'] };
    const ids = applyFlowFilters(events, filters).map((e) => e.id);
    expect(ids).not.toContain('d');
  });
});

describe('toggleChip', () => {
  it('adds a value not yet present', () => {
    expect(toggleChip(['a'], 'b')).toEqual(['a', 'b']);
  });
  it('removes a value already present', () => {
    expect(toggleChip(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('counts', () => {
  const events = [
    event({ place: 'journal', fronts: ['health'] }),
    event({ place: 'journal', fronts: ['health', 'connection'] }),
    event({ place: 'code', fronts: [] }),
  ];
  it('countsByPlace tallies one bucket per event', () => {
    expect(countsByPlace(events)).toEqual({ journal: 2, code: 1 });
  });
  it('countsByFront tallies across each event\'s front list', () => {
    expect(countsByFront(events)).toEqual({ health: 2, connection: 1 });
  });
});

describe('visiblePlaces / visibleFronts', () => {
  const events = [event({ place: 'journal', fronts: ['health'] })];

  it('only lists places/fronts present in the window', () => {
    expect(visiblePlaces(events, []).map((c) => c.id)).toEqual(['journal']);
    expect(visibleFronts(events, []).map((c) => c.id)).toEqual(['health']);
  });

  it('keeps a selected chip visible even once its count drops to 0', () => {
    // 'code' isn't present in this window at all, but it's selected — a
    // selection must never become unremovable just because the window moved.
    const places = visiblePlaces(events, ['code']);
    const codeChip = places.find((c) => c.id === 'code');
    expect(codeChip).toEqual({ id: 'code', count: 0 });

    const fronts = visibleFronts(events, ['exocortex']);
    const exoChip = fronts.find((c) => c.id === 'exocortex');
    expect(exoChip).toEqual({ id: 'exocortex', count: 0 });
  });

  it('orders place chips per the fixed PLACE_ORDER, not insertion order', () => {
    const mixed = [
      event({ place: 'code' }),
      event({ place: 'journal' }),
      event({ place: 'docs' }),
    ];
    expect(visiblePlaces(mixed, []).map((c) => c.id)).toEqual(['journal', 'docs', 'code']);
  });
});
