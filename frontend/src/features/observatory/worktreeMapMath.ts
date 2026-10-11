/**
 * worktreeMapMath.ts — the small decisions the Worktrees page draws from.
 *
 * What this is, in plain English: the page shows each copy of the code as a
 * plot with the agents working in it as rings, the way the Terrain map draws
 * agent orbs. This file decides, from the raw numbers, how bright a ring is
 * (how recently it did something), how big (how much it did), what share of
 * its work was editing vs running vs looking, whether two agents are writing
 * in the same tree at once, and what to call a tree. Kept apart from the page
 * so it can be tested without a browser.
 *
 * Touches: WorktreeMapPage.tsx (the only reader), worktreeMapApi.ts (the types).
 */
import type { Tree, TreeAgent } from './worktreeMapApi';

/** How recently an agent did something here — drives the ring's opacity, the
 * same in-print / out-of-print dimming Terrain gives its orbs. */
export type Recency = 'live' | 'recent' | 'earlier';

const LIVE_MS = 2 * 60_000;
const RECENT_MS = 10 * 60_000;

/** Pick the recency tier from a local ISO stamp. */
export function recencyOf(stamp: string | null, nowMs: number): Recency {
  const at = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(at)) return 'earlier';
  const age = nowMs - at;
  if (age <= LIVE_MS) return 'live';
  if (age <= RECENT_MS) return 'recent';
  return 'earlier';
}

/** Ring radius from how much an agent did here. A square root, so one busy
 * agent doesn't dwarf the rest; floored so a single touch is still a ring you
 * can tap, capped so a plot never overflows. */
export function orbRadius(agent: Pick<TreeAgent, 'edited' | 'ran' | 'looked'>): number {
  const work = agent.edited * 2 + agent.ran + agent.looked * 0.25;
  return Math.round(Math.min(30, 13 + 3 * Math.sqrt(work)));
}

/** Its footprint as three shares that sum to 1: ember (edited), gold (ran),
 * ash (looked). Zero work → all ash, so the bar still draws. */
export function footprint(agent: Pick<TreeAgent, 'edited' | 'ran' | 'looked'>) {
  const total = agent.edited + agent.ran + agent.looked;
  if (total === 0) return { edited: 0, ran: 0, looked: 1 };
  return { edited: agent.edited / total, ran: agent.ran / total, looked: agent.looked / total };
}

/** Agents that WROTE here (edited or ran) inside the last ten minutes. Two or
 * more is the collision worktrees exist to prevent — the page says so. */
export function writersNow(tree: Tree, nowMs: number): TreeAgent[] {
  return tree.agents.filter((a) => a.last_write_at !== null && recencyOf(a.last_write_at, nowMs) !== 'earlier');
}

/** A tree's name: the folder, since that's what a session `cd`s into. */
export function treeName(tree: Tree): string {
  const parts = tree.path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? tree.path;
}

/** Busy trees first (by how many wrote here), then the rest with the repo's
 * own checkout leading its copies. */
export function orderTrees(trees: Tree[]): Tree[] {
  const writers = (t: Tree) => t.agents.filter((a) => a.last_write_at !== null).length;
  return [...trees].sort(
    (a, b) =>
      writers(b) - writers(a) ||
      b.agents.length - a.agents.length ||
      Number(b.main) - Number(a.main) ||
      treeName(a).localeCompare(treeName(b)),
  );
}

/** Every tree a session touched, for the "also working in" row. */
export function treesOf(conv: string, trees: Tree[]): Tree[] {
  return trees.filter((t) => t.agents.some((a) => a.conv === conv));
}
