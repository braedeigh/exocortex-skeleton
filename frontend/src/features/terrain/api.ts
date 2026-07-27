/**
 * api.ts — typed fetch for GET /api/observatory/terrain (routes/observatory.py,
 * built in parallel with this page — see terrainGraph.ts for the contract this
 * was coded against). "Where is being worked on": every repo's file tree in
 * the last `window_days`, files glowing ember by recency of touch.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export interface TerrainSession {
  id: string;
  title: string;
  writes: number;
  reads: number;
  /**
   * How many files this session CREATED fresh (a Write to a path that didn't
   * exist), a subset of `writes`. Optional — old sidecars/payloads predate it.
   * Terrain rings a created file green while its agent is the focused/active one.
   */
  creates?: number;
  /**
   * The session's last touch of this file — an ISO-8601 **string**, not unix
   * seconds, because it comes from the footprints sidecar rather than from
   * git (see `files[].touches`, which really are numbers). The two units sit
   * side by side in one payload, so never compare this against a touch
   * directly: run it through `sessionLastSeconds()` in terrainGraph.ts.
   * Typed loosely because old sidecars may carry a number or nothing at all.
   */
  last: string | number | null;
}

export interface TerrainFile {
  path: string;
  /** Unix seconds, newest first. */
  touches: number[];
  sessions: TerrainSession[];
}

export interface TerrainRepo {
  id: 'skeleton' | 'vault' | string;
  name: string;
  root: string;
  files: TerrainFile[];
  /** How many files this repo actually has in the window, before the
   * hottest-N cut — the honesty count behind "showing 700 of 3,260". */
  files_total: number;
}

/** Top-level session roster — who's been on the terrain, and who's on it
 * right now. Running sessions get their live file touches merged into
 * files[].sessions server-side, with fresh payloads every ~5s while anything
 * runs. */
export interface TerrainLiveSession {
  id: string;
  title: string;
  bot: string;
  running: boolean;
  last: string | null;
}

export interface TerrainData {
  generated_at: string;
  window_days: number;
  /** The hottest-N-per-repo cut this payload was built at; null = every file.
   * The Files slider reads it to know whether it can grow locally or must
   * refetch. */
  file_cap: number | null;
  repos: TerrainRepo[];
  /** Optional until the backend half lands — session orbs degrade to the
   * file-level sessions data when absent. */
  sessions?: TerrainLiveSession[];
}

export const TERRAIN_KEY = ['terrain'] as const;

function getTerrain(limit: number | null, signal?: AbortSignal): Promise<TerrainData> {
  const q = limit === null ? 'all' : String(limit);
  return api.get(`/api/observatory/terrain?limit=${encodeURIComponent(q)}`, signal);
}

/**
 * Mostly slow-changing recency data — except in live mode (a session is
 * running AND the page is visible), when this polls every ~5s so a working
 * session's touches light up across the map as they happen. react-query
 * already pauses interval refetches for backgrounded tabs; the caller gates
 * `live` on document visibility on top of that.
 *
 * `limit` is the Files slider's fetch tier (null = every file), part of the
 * query key so each tier caches separately — sliding back down to a smaller
 * map is then instant, served from the cache rather than the network. The
 * date controls never appear here: they filter timestamps the payload
 * already carries, entirely client-side.
 */
export function useTerrain(live = false, limit: number | null = 350) {
  return useQuery({
    queryKey: [...TERRAIN_KEY, limit] as const,
    queryFn: async ({ signal }) => getTerrain(limit, signal),
    staleTime: live ? 4_000 : 60_000,
    refetchInterval: live ? 5_000 : false,
    // Keep the previous tier's map on screen while a bigger one loads, so
    // dragging the slider never blanks the canvas.
    placeholderData: (prev) => prev,
  });
}

// --- one file's text, for the code modal ------------------------------------

export interface TerrainFileContent {
  repo: string;
  path: string;
  /** Bytes on disk — may exceed `content` when truncated. */
  size: number;
  lines: number;
  binary: boolean;
  truncated: boolean;
  /** The file's own leading docblock, collapsed to prose. null when the file
   * doesn't explain itself — the server never guesses. */
  summary: string | null;
  /** null for binaries. */
  content: string | null;
}

/**
 * GET /api/observatory/terrain/file — the tapped node's actual text.
 * Enabled only while the modal is open, and cached indefinitely per
 * repo+path: source on disk doesn't move under you mid-read, and reopening
 * the same file should be instant.
 */
export function useTerrainFile(repo: string | null, path: string | null) {
  return useQuery({
    queryKey: ['terrain-file', repo, path] as const,
    queryFn: async ({ signal }) =>
      api.get<TerrainFileContent>(
        `/api/observatory/terrain/file?repo=${encodeURIComponent(repo!)}&path=${encodeURIComponent(path!)}`,
        signal,
      ),
    enabled: repo !== null && path !== null,
    staleTime: 5 * 60_000,
  });
}
