/**
 * wikiThreadIndex.ts — pure logic for the wiki home's "browse by front"
 * thread index (WikiHome.tsx). Mirrors threadsTree.ts's split between pure,
 * unit-testable logic and the React that renders it. Two views over the
 * same flat `WikiThreadSummary[]` roster (GET /api/wiki/home's `threads`):
 *
 *   - No filter: grouped by PRIMARY front (`fronts[0]`), one group per front
 *     that owns at least one thread, in fronts.json's own order; threads
 *     with no fronts at all fall into a trailing "Other" group.
 *   - A front selected: a flat list of every thread whose `fronts` list
 *     INCLUDES that front (the lens semantics ThreadsPage's front chips use
 *     — a thread "visiting" a front shows under it too, not just the owner).
 *
 * Within any group/list, active threads sort before dormant ones; ties break
 * by name.
 */
import type { WikiFront, WikiThreadSummary } from './useWikiHome';

function byActiveThenName(a: WikiThreadSummary, b: WikiThreadSummary): number {
  const aDormant = a.status === 'dormant';
  const bDormant = b.status === 'dormant';
  if (aDormant !== bDormant) return aDormant ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/** One front's group in the ungrouped browse view. `front` is null for the
 * trailing "Other" group (threads with an empty `fronts` list). */
export interface WikiThreadGroup {
  front: WikiFront | null;
  threads: WikiThreadSummary[];
}

/** Threads grouped by primary front (fronts[0]), ordered by the fronts
 * vocabulary's own order; a thread with no fronts lands in a trailing
 * "Other" group. A front with no threads owning it is omitted entirely. */
export function groupThreadsByPrimaryFront(
  threads: WikiThreadSummary[],
  fronts: WikiFront[],
): WikiThreadGroup[] {
  const byFront = new Map<string, WikiThreadSummary[]>();
  const other: WikiThreadSummary[] = [];

  for (const t of threads) {
    const primary = t.fronts[0];
    if (!primary) {
      other.push(t);
      continue;
    }
    const bucket = byFront.get(primary);
    if (bucket) bucket.push(t);
    else byFront.set(primary, [t]);
  }

  const groups: WikiThreadGroup[] = fronts
    .filter((f) => byFront.has(f.id))
    .map((f) => ({ front: f, threads: byFront.get(f.id)!.slice().sort(byActiveThenName) }));

  if (other.length > 0) {
    groups.push({ front: null, threads: other.slice().sort(byActiveThenName) });
  }
  return groups;
}

/** The front-filter's flat list: every thread carrying `frontId` anywhere in
 * its `fronts`, active-before-dormant, then by name. */
export function filterThreadsByFront(threads: WikiThreadSummary[], frontId: string): WikiThreadSummary[] {
  return threads
    .filter((t) => t.fronts.includes(frontId))
    .slice()
    .sort(byActiveThenName);
}
