/**
 * api.ts — the typed fetches behind the Terrain map, and the shapes of what
 * comes back.
 *
 * The main one is GET /api/observatory/terrain (routes/terrain.py): "where is
 * being worked on" — every repo's file tree across its whole git history, with
 * which agent sessions touched which file. terrainGraph.ts turns that payload
 * into the map's nodes. Beside it: one file's text and its per-line edit and
 * run times for the code pane (the /terrain/file doors), and the database's
 * tables for the map's table layer (routes/terrain_tables.py → tableNodes.ts).
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
  /** Git touches — unix seconds, newest first. The EMBER channel. */
  touches: number[];
  sessions: TerrainSession[];
  /** When this file actually RAN — the GOLD channel. Unix seconds in
   * 5-minute buckets, oldest first, from runtime_sensor.py's sidecar via
   * routes/terrain.py. Python only: the sensor can't see the browser, so a
   * .tsx never carries this. Absent when the file never ran on record. */
  ran?: number[];
  /** Synthetic only — the server never sends this. The pond tile
   * (pondNodes.ts) carries the last month of the journal here, bucketed per
   * day and oldest first, so the canvas can draw the month inside its square
   * and terrainGraph can light each day with the live heat lens. */
  days?: { day: string; touches: number[] }[];
  /** Synthetic only — the server never sends this on a file. A table node
   * (tableNodes.ts) carries the table it stands for here, so the canvas can
   * draw it as a rectangle (columns wide, rows tall) and the page can show
   * its columns when she taps it. */
  table?: TerrainTable;
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
  /** Not archived — the map's "Open" pool. A real server-side state, unlike
   * the browser-local heartbeat the agent bar used to call "active".
   * Optional: payloads built before this field existed simply don't say. */
  open?: boolean;
  /** 'personal' | 'coding' | 'orchestra' — which room the session lives in, derived
   * server-side for entries predating the field. Drives the agent bar's
   * section filter. */
  lane?: string;
  last: string | null;
}

export interface TerrainData {
  generated_at: string;
  /** null since the payload went whole-history (the server used to cut at 90
   * days and said so here); kept for old cached payloads, and as the empty-map
   * fallback horizon in terrainEarliestTouch. */
  window_days: number | null;
  /** The hottest-N-per-repo cut this payload was built at; null = every file.
   * The Files slider reads it to know whether it can grow locally or must
   * refetch. */
  file_cap: number | null;
  repos: TerrainRepo[];
  /** Optional until the backend half lands — session orbs degrade to the
   * file-level sessions data when absent. */
  sessions?: TerrainLiveSession[];
  /**
   * The journal's last month for the pond tile: one DENSE row per day, oldest
   * first, each carrying the unix-second times of the cards written that day.
   * Counted in the card table rather than in `repos[].files`, which is cut to
   * the hottest N and so under-draws the pond badly (routes/terrain.py
   * `_pond_days`). Optional: an install with no journal mirror sends [], and
   * pondNodes.ts falls back to counting card files.
   */
  pond_days?: { day: string; touches: number[] }[];
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
 * At rest the payload never goes stale on its own: opening the page, or
 * coming back to the tab, re-uses what's already cached instead of fetching,
 * and the map she left is the map she returns to. Fresh data is something she
 * ASKS for — the refresh chip in the top bar calls `refetch`. Live mode is the
 * one exception, and it earns it: the whole point there is watching it happen.
 *
 * Prompt that produced it: "i want for the map to not have to reload every
 * time i open the page ... there can be a button on there somewhere that i can
 * actively refresh it."
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
    staleTime: live ? 4_000 : Infinity,
    refetchInterval: live ? 5_000 : false,
    // Keep the previous tier's map on screen while a bigger one loads, so
    // dragging the slider never blanks the canvas.
    placeholderData: (prev) => prev,
  });
}

// --- the database's tables, for the map's table layer -------------------------

export interface TerrainTableColumn {
  name: string;
  /** The declared SQLite type, as written in CREATE TABLE ('' when none). */
  type: string;
  notnull: boolean;
  /** Part of the primary key — the column(s) that identify one row. */
  pk: boolean;
}

/** One foreign key: "my `column` holds a value from `table`.`to`". `to` is
 * null when the key names no target column, which means that table's
 * primary key. */
export interface TerrainTableForeignKey {
  column: string;
  table: string;
  to: string | null;
}

/** The hand-written plain-English note on a table (table_notes.json). */
export interface TerrainTableNotes {
  /** What information the table contains. */
  holds: string;
  /** Where its rows come from — including the indirect path (a page edits a
   * collection, a store module mirrors it here) that a code scan can't see. */
  source: string;
  /** 'mirror' = a copy that can be wiped and rebuilt from its source;
   * 'record' = the only copy; 'store' = the database of record itself;
   * 'mixed' = some rows of each. */
  kind: 'mirror' | 'record' | 'store' | 'mixed';
  /** The column that says WHEN a row happened — what "newest first" sorts by.
   * null when the table has no such column; missing on an old payload. */
  time_column?: string | null;
  /** One entry per column: what it contains, and — for a column that holds a
   * fixed set of categories — what each value means. */
  columns?: Record<string, TerrainColumnNote>;
}

/** The hand-written note on one column. */
export interface TerrainColumnNote {
  holds: string;
  values?: Record<string, string>;
}

/** One Python file whose SQL names the table, and the first line it does. */
export interface TerrainTableCodeHit {
  path: string;
  line: number;
}

export interface TerrainTable {
  name: string;
  rows: number;
  /** Bytes the table's own pages take on disk; null when this SQLite build
   * can't measure it (no `dbstat`) — "not measured", never zero. */
  bytes: number | null;
  /** Bytes taken by the table's indexes, on top of `bytes`. */
  index_bytes: number | null;
  columns: TerrainTableColumn[];
  indexes: { name: string; unique: boolean }[];
  foreign_keys: TerrainTableForeignKey[];
  /** null when nobody has described this table yet; missing entirely on a
   * payload from a server that predates the notes. */
  notes?: TerrainTableNotes | null;
  /** Which files create, write to, and read the table — found by the server
   * scanning the app's Python for SQL that names it. A text search: it misses
   * SQL built from variables and code that goes through another module. */
  code?: {
    creates: TerrainTableCodeHit[];
    writes: TerrainTableCodeHit[];
    reads: TerrainTableCodeHit[];
  };
}

/** GET /api/observatory/terrain/tables (routes/terrain_tables.py). `repo` and
 * `path` say where the database file sits — which repo, and its path inside
 * it — so the tables hang off the folder the database really lives in. Both
 * are null when the data directory is outside every repo. */
export interface TerrainTables {
  repo: string | null;
  path: string | null;
  /** Which repo the `code` file paths belong to (the app-code repo). */
  code_repo: string;
  tables: TerrainTable[];
}

/**
 * The tables change shape only when a migration runs, and their row counts
 * drift slowly, so this is fetched once and kept for five minutes. Owner only:
 * the endpoint is closed to visitors, so the caller passes `enabled: false`
 * for them rather than spending a request on a 401.
 */
export function useTerrainTables(enabled: boolean) {
  return useQuery({
    queryKey: ['terrain-tables'] as const,
    queryFn: async ({ signal }) =>
      api.get<TerrainTables>('/api/observatory/terrain/tables', signal),
    enabled,
    staleTime: 5 * 60_000,
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

// --- when each line was last edited, for the pane's red-edits toggle --------

export interface TerrainFileEdits {
  repo: string;
  path: string;
  /** One unix-second stamp per line, in file order — the commit that last
   * touched the line, or "now" for a line changed on disk and not yet
   * committed. null when git has no history for the file (untracked, or
   * not in a repo): the pane then paints nothing rather than guessing. */
  edits: number[] | null;
}

/**
 * GET /api/observatory/terrain/file/edits — git blame, one stamp per line
 * (routes/terrain.py `_terrain_line_edits`).
 * Fetched only while the toggle is on (`enabled`), so a plain read never
 * pays for a blame. Short stale time — thirty seconds — rather than the
 * file's five minutes: an agent editing the file changes this answer line by
 * line, and the point of the colour is to see that.
 */
export function useTerrainFileEdits(repo: string | null, path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['terrain-file-edits', repo, path] as const,
    queryFn: async ({ signal }) =>
      api.get<TerrainFileEdits>(
        `/api/observatory/terrain/file/edits?repo=${encodeURIComponent(repo!)}&path=${encodeURIComponent(path!)}`,
        signal,
      ),
    enabled: enabled && repo !== null && path !== null,
    staleTime: 30_000,
  });
}

// --- when each line's function last ran, for the pane's gold "ran" toggle ----

export interface TerrainFileRuns {
  repo: string;
  path: string;
  /** One unix-second stamp per line, in file order — when the innermost
   * function around that line last ran; 0 for a line in no function, or in
   * one the sensor hasn't seen run. null when the sensor can't say anything
   * about the file (it only sees Python, and only what has run since it was
   * switched on): the pane then paints nothing rather than guessing. */
  runs: number[] | null;
  /** The sensor's bucket, in seconds — every stamp is rounded down to it, so
   * "ran 0–5 minutes ago" is as fine as this ever gets. */
  sampled: number;
}

/**
 * GET /api/observatory/terrain/file/runs — the runtime sensor, one stamp per
 * line (routes/terrain.py `_terrain_line_runs`).
 * Fetched only while the toggle is on (`enabled`), so a plain read never
 * pays for it. Stale after a minute, the sensor's own cycle: code she just
 * exercised should turn gold while she's still looking at it.
 */
export function useTerrainFileRuns(repo: string | null, path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['terrain-file-runs', repo, path] as const,
    queryFn: async ({ signal }) =>
      api.get<TerrainFileRuns>(
        `/api/observatory/terrain/file/runs?repo=${encodeURIComponent(repo!)}&path=${encodeURIComponent(path!)}`,
        signal,
      ),
    enabled: enabled && repo !== null && path !== null,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
