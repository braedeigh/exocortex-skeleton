/**
 * worktreeMapApi.ts — the typed door to /api/worktree-map (routes/worktree_map.py).
 *
 * What this is, in plain English: every copy of the code on this machine (the
 * main checkout, the vault, each agent's worktree) with the sessions that
 * touched it in a time window, worked out server-side from their tool calls.
 * One polled query, shared by the roster's door and the Worktrees page — both
 * use the same key per window, so they never ask twice.
 *
 * Touches: routes/worktree_map.py (the endpoint), WorktreeMapDoor.tsx,
 * WorktreeMapPage.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** The three kinds of touch — Terrain's three: EMBER edited, GOLD ran, and a
 * faint read. */
export type TouchKind = 'edited' | 'ran' | 'looked';

export interface TreeAgent {
  conv: string;
  title: string;
  lane: string | null;
  /** True when this is the tree the session was born in (its starting folder). */
  home: boolean;
  edited: number;
  ran: number;
  looked: number;
  first_at: string;
  last_at: string;
  /** Last edit or command here — null if it only ever looked. */
  last_write_at: string | null;
  files: { path: string; edits: number }[];
  recent: { at: string; tool: string; kind: TouchKind; what: string }[];
}

export interface Tree {
  path: string;
  /** The repo's folder name — "skeleton", "personal". */
  repo: string;
  branch: string | null;
  head: string;
  /** The repo's own checkout, not a copy of it. */
  main: boolean;
  main_branch: string | null;
  /** Git still lists it but the folder is gone. */
  missing: boolean;
  /** Git facts arrive a beat after the first load (they're cached server-side
   * and refreshed in the background), so any of these can be null. */
  ahead: number | null;
  behind: number | null;
  dirty: number | null;
  last_commit_at: string | null;
  agents: TreeAgent[];
}

export interface WorktreeMap {
  window: number;
  now: string;
  trees: Tree[];
}

/** Every tree and who's in it, polled while something is watching. */
export function useWorktreeMap(windowSeconds: number, refetchMs = 5_000) {
  return useQuery({
    queryKey: ['worktree-map', windowSeconds] as const,
    queryFn: ({ signal }) => api.get<WorktreeMap>(`/api/worktree-map?window=${windowSeconds}`, signal),
    staleTime: Math.min(refetchMs, 4_000),
    refetchInterval: refetchMs,
  });
}
