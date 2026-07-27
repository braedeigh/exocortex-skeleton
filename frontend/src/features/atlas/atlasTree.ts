/**
 * atlasTree.ts — pure sorting logic for the Atlas page. Buckets every
 * observatory session into its home: the exocortex front's five domain
 * shelves (the hero region), the other 11 life fronts (shelves when they
 * have sessions, a muted chip row when they don't), and an Unsorted shelf
 * for sessions with front === null.
 */
import type { AtlasDomain, AtlasFront, AtlasSession } from './api';

export const EXOCORTEX_FRONT_ID = 'exocortex';

export interface DomainShelf {
  domain: AtlasDomain;
  sessions: AtlasSession[];
}

export interface FrontShelf {
  front: AtlasFront;
  sessions: AtlasSession[];
}

export interface AtlasGrouping {
  /** The exocortex front's metadata, if present in fronts (it always should be). */
  exocortexFront: AtlasFront | null;
  /** One shelf per known domain, in API order — empty ones still included. */
  domainShelves: DomainShelf[];
  /** Exocortex-front sessions whose domain id matches none of `domains` — a
   * safety-valve shelf, only present when non-empty. */
  otherExocortexSessions: AtlasSession[];
  /** The other 11 life fronts that DO have sessions, in API order. */
  populatedFrontShelves: FrontShelf[];
  /** The other 11 life fronts that have none — rendered as a muted chip row. */
  emptyFronts: AtlasFront[];
  /** front === null (or missing) — sessions nobody's claimed yet. */
  unsorted: AtlasSession[];
}

/** Newest-first, pinned sessions pinned to the top. */
export function sortSessions(sessions: AtlasSession[]): AtlasSession[] {
  return [...sessions].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const at = a.last_at ? Date.parse(a.last_at) : 0;
    const bt = b.last_at ? Date.parse(b.last_at) : 0;
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
}

export function groupAtlas(fronts: AtlasFront[], domains: AtlasDomain[], sessions: AtlasSession[]): AtlasGrouping {
  const exocortexFront = fronts.find((f) => f.id === EXOCORTEX_FRONT_ID) ?? null;
  const otherFronts = fronts.filter((f) => f.id !== EXOCORTEX_FRONT_ID);

  const exoSessions = sessions.filter((s) => s.front === EXOCORTEX_FRONT_ID);
  const domainIds = new Set(domains.map((d) => d.id));

  const domainShelves: DomainShelf[] = domains.map((domain) => ({
    domain,
    sessions: sortSessions(exoSessions.filter((s) => s.domain === domain.id)),
  }));
  const otherExocortexSessions = sortSessions(exoSessions.filter((s) => !s.domain || !domainIds.has(s.domain)));

  const populatedFrontShelves: FrontShelf[] = [];
  const emptyFronts: AtlasFront[] = [];
  for (const front of otherFronts) {
    const matches = sortSessions(sessions.filter((s) => s.front === front.id));
    if (matches.length > 0) populatedFrontShelves.push({ front, sessions: matches });
    else emptyFronts.push(front);
  }

  const unsorted = sortSessions(sessions.filter((s) => !s.front));

  return {
    exocortexFront,
    domainShelves,
    otherExocortexSessions,
    populatedFrontShelves,
    emptyFronts,
    unsorted,
  };
}
