import { describe, expect, it } from 'vitest';
import { groupAtlas, sortSessions } from './atlasTree';
import type { AtlasDomain, AtlasFront, AtlasSession } from './api';

const fronts: AtlasFront[] = [
  { id: 'exocortex', name: 'Exocortex' },
  { id: 'health', name: 'Health' },
  { id: 'appearance', name: 'Appearance' },
];

const domains: AtlasDomain[] = [
  { id: 'ui-design', name: 'UI & Design' },
  { id: 'keeper-journal', name: 'Keeper & Journal' },
];

function session(overrides: Partial<AtlasSession>): AtlasSession {
  return {
    id: overrides.id ?? 'x',
    title: 'Untitled',
    front: null,
    bot: 'keeper',
    ...overrides,
  };
}

describe('groupAtlas', () => {
  it('splits exocortex-front sessions into domain shelves, in domain order', () => {
    const sessions = [
      session({ id: 'a', front: 'exocortex', domain: 'keeper-journal' }),
      session({ id: 'b', front: 'exocortex', domain: 'ui-design' }),
    ];
    const g = groupAtlas(fronts, domains, sessions);
    expect(g.domainShelves.map((d) => d.domain.id)).toEqual(['ui-design', 'keeper-journal']);
    expect(g.domainShelves[0].sessions.map((s) => s.id)).toEqual(['b']);
    expect(g.domainShelves[1].sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('renders empty domains with zero sessions rather than dropping them', () => {
    const g = groupAtlas(fronts, domains, []);
    expect(g.domainShelves).toHaveLength(2);
    expect(g.domainShelves.every((d) => d.sessions.length === 0)).toBe(true);
  });

  it('bucket exocortex sessions with an unknown/missing domain into the overflow bucket', () => {
    const sessions = [session({ id: 'a', front: 'exocortex', domain: 'nonexistent' }), session({ id: 'b', front: 'exocortex' })];
    const g = groupAtlas(fronts, domains, sessions);
    expect(g.otherExocortexSessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('splits life fronts into populated shelves vs. an empty-fronts chip list', () => {
    const sessions = [session({ id: 'a', front: 'health' })];
    const g = groupAtlas(fronts, domains, sessions);
    expect(g.populatedFrontShelves.map((f) => f.front.id)).toEqual(['health']);
    expect(g.emptyFronts.map((f) => f.id)).toEqual(['appearance']);
  });

  it('collects front === null/undefined sessions as unsorted', () => {
    const sessions = [session({ id: 'a', front: null }), session({ id: 'b', front: 'health' })];
    const g = groupAtlas(fronts, domains, sessions);
    expect(g.unsorted.map((s) => s.id)).toEqual(['a']);
  });
});

describe('sortSessions', () => {
  it('puts pinned sessions first regardless of recency', () => {
    const sessions = [
      session({ id: 'recent', last_at: '2026-07-24T12:00:00' }),
      session({ id: 'pinned-old', last_at: '2020-01-01T00:00:00', pinned: true }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['pinned-old', 'recent']);
  });

  it('otherwise sorts newest last_at first', () => {
    const sessions = [
      session({ id: 'older', last_at: '2026-07-20T00:00:00' }),
      session({ id: 'newer', last_at: '2026-07-24T00:00:00' }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['newer', 'older']);
  });
});
