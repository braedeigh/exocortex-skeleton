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
  /** A VISITOR's copy of this session, anonymized server-side
   * (terrain._redact_sessions): `id` is an opaque handle rather than the real
   * one (session ids are timestamps), and `title` is the room's name —
   * "Personal" / "Orchestra". Only Coding sessions keep their identity. The
   * counts and `last` are untouched: the owner's line was "activity is fine
   * to show". Never set for the owner's own view. */
  anon?: boolean;
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
  /** Size on disk in bytes — what the file's dot is sized by
   * (terrainCanvas.ts fileRadius). Null when git remembers the file but the
   * disk no longer has it; absent on synthetic files and older payloads. */
  bytes?: number | null;
  /** Synthetic only — the server never sends this. The pond tile
   * (pondNodes.ts) carries the last month of the journal here, bucketed per
   * day and oldest first, so the canvas can draw the month inside its square
   * and terrainGraph can light each day with the live heat lens. */
  days?: { day: string; touches: number[] }[];
  /** Synthetic only — the server never sends this on a file. A table node
   * (tableNodes.ts) carries the table it stands for here, so the canvas can
   * draw it as a rectangle (columns wide, rows tall) and the page can show
   * its columns when she taps it. On a table node the three lists above are
   * re-used for the table's own history: `touches` is when its structure last
   * changed, `ran` when it last had a row written, and `sessions` the agents
   * that wrote it (tableNodes.ts addTableNodes). */
  table?: TerrainTable;
}

export interface TerrainRepo {
  /** 'skeleton' or 'vault' on the main map; a build's own id on a build's map. */
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
  /** Anonymized for a visitor — see TerrainSession.anon. `bot` is absent on
   * these: naming the persona is identity too. */
  anon?: boolean;
  bot?: string;
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
  /** The conversation it was spun off from, if it was — drawn as an arrow
   * parent → child (terrainLineage.ts). For a visitor, a private parent is
   * its opaque handle, which still matches that orb's id. */
  spawned_from?: string | null;
}

export interface TerrainData {
  generated_at: string;
  /** When this map was BUILT, as a unix second. generated_at is the private
   * box's local wall time with no zone on it; this is the same moment stated
   * in a way a visitor in another timezone can subtract from. */
  generated_ts?: number;
  /** Set only by a public mirror (routes/terrain_mirror.py): this map was
   * published in from the private box rather than built here, and these say
   * when. The refresh chip shows THIS age instead of the fetch age — a
   * browser can re-fetch a frozen artifact every five seconds, so "fetched
   * just now" would be true and say nothing about whether the map is live. */
  mirror?: boolean;
  published_at?: string;
  published_ts?: number;
  /** This payload is a stranger's copy: every non-Coding session has had its
   * title and id replaced (routes/terrain.py, `_redact_sessions`). Absent for
   * the owner. The map doesn't branch on it — the orbs are already inert for
   * a visitor and the hovercard already has no data — it's here so the
   * payload says out loud which of the two views it is. */
  sessions_redacted?: boolean;
  /** null since the payload went whole-history (the server used to cut at 90
   * days and said so here); kept for old cached payloads, and as the empty-map
   * fallback horizon in terrainEarliestTouch. */
  window_days: number | null;
  /** The hottest-N-per-repo cut this payload was built at; null = every file.
   * The Files slider reads it to know whether it can grow locally or must
   * refetch. */
  file_cap: number | null;
  /** Set only on a BUILD's map (`?build=<id>`): this payload draws one of the
   * owner's other git folders instead of the app code and the vault, and this
   * names it. Absent on the main map. */
  build?: { id: string; name: string };
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
  /**
   * The folders drawn as spiral coils (coilFolders.ts), each listed straight
   * off disk, uncapped: where it is, where its dots get their time, the
   * window steps its centre walks through, and every filename in it.
   *
   * WHICH folders is hers — routes/terrain.py reads it from
   * `data/terrain_coils.json` — so adding one is editing that file, not the
   * app.
   *
   * A STAMP coil is paths only. Its moment is read out of the filename by one
   * parser on the client, so a time from the server would be a second clock,
   * free to disagree with the first. A GIT coil is the other way round: the
   * client has no way to know when she last edited something, so `times` is
   * not a second clock, it is the only one.
   *
   * Uncapped because it has to be: `repos[].files` is cut to the hottest N,
   * and measured on this vault that cut leaves 0 of 633 uploads and 7 of
   * tulku/people's 75. Optional — an install whose server predates this sends
   * nothing, and coilFolders.ts falls back to whatever survived the cap.
   */
  coils?: {
    repo: string;
    prefix: string;
    time: 'stamp' | 'git';
    windows: (number | null)[];
    paths: string[];
    /** Git coils only: when each of `paths` was last edited, aligned with it. */
    times?: (number | null)[];
  }[];
}

export const TERRAIN_KEY = ['terrain'] as const;

function getTerrain(limit: number | null, build: string | null, signal?: AbortSignal): Promise<TerrainData> {
  const q = limit === null ? 'all' : String(limit);
  const which = build ? `&build=${encodeURIComponent(build)}` : '';
  return api.get(`/api/observatory/terrain?limit=${encodeURIComponent(q)}${which}`, signal);
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
 *
 * `build` asks for one build's map instead of the main one (the Builds room,
 * buildsApi.ts). It is part of the query key too, so a build's map and the
 * main map never share a cache entry; the main map's key is unchanged.
 */
export function useTerrain(live = false, limit: number | null = 350, build: string | null = null) {
  return useQuery({
    queryKey: build ? ([...TERRAIN_KEY, limit, 'build', build] as const) : ([...TERRAIN_KEY, limit] as const),
    queryFn: async ({ signal }) => getTerrain(limit, build, signal),
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

/** One Python file whose SQL names the table, and where it does. */
export interface TerrainTableCodeHit {
  path: string;
  /** The first line it names the table on — what the card's button says. */
  line: number;
  /** EVERY line it names the table on, ascending. What the file opens at and
   * steps through (tableMentions.ts). Missing on a payload from a server that
   * predates it, which reads as "only `line` is known". */
  lines?: number[];
  /** Present when the file reaches the table through store.read/write/mutate
   * rather than SQL: the collection names that led here (the `docs` row, or a
   * typed collection's tables). Absent on a hit found by SQL alone. */
  collections?: string[];
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
   * scanning the app's Python for SQL that names it, and for store calls whose
   * collection lands in it. A text search: it misses SQL built from variables,
   * store calls on a variable collection, and mirrors rebuilt later. */
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
  /** The leg before the tables: which frontend files reach which route
   * modules, following the names each file imports (apiseam.py file_reach).
   * Paths are in `code_repo`. Missing on a server that predates it. */
  calls?: TerrainFrontendCall[];
}

/** One frontend file and the route modules it reaches, each with every `/api`
 * path it names there. A static read of the source: what CAN be called, not a
 * record of what ran. */
export interface TerrainFrontendCall {
  path: string;
  routes: { path: string; calls: string[] }[];
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

// --- when each table last changed, for its two outlines -----------------------

/** One agent session that changed a table. */
export interface TerrainTableWriter {
  /** The conversation id — the same id the map's session orbs carry. */
  id: string;
  /** How many times the table log noted this session writing the table (at
   * most one a minute, so "a few" means "over a few minutes", not "few rows"). */
  writes: number;
  /** Its last write, unix seconds. */
  last: number;
  /** True when it changed the table's definition, not only its rows. */
  structure: boolean;
}

/** What is known about when one table changed. Every time is unix seconds, or
 * null for "not recorded" — which is not the same as "never", and is drawn as
 * no outline rather than a cold one. */
export interface TerrainTableActivity {
  /** From git: the newest change to the code that defines the table (its
   * CREATE TABLE statement, or an ALTER TABLE naming it). */
  defined_at: number | null;
  /** From the table log: when this database actually created or altered it. */
  migrated_at: number | null;
  /** From the table log: the last time a statement wrote its rows. */
  rows_at: number | null;
  /** Recent row writes, newest first. */
  row_times: number[];
  /** Agent sessions that wrote it. Empty for a visitor. */
  sessions: TerrainTableWriter[];
}

/** GET /api/observatory/terrain/tables/activity (routes/terrain_tables.py
 * build_activity). `recording_since` is when the table log (tablelog.py) was
 * switched on: nothing about row writes is known before it. */
export interface TerrainTablesActivity {
  recording_since: number | null;
  tables: Record<string, TerrainTableActivity>;
}

/**
 * When each table last changed. Small and cheap to build, and kept apart from
 * useTerrainTables for that reason: that one counts every table's rows and is
 * fetched once, this one is asked again every ten seconds while an agent is
 * running (`live`), so a table an agent just wrote lights up while she watches.
 */
export function useTerrainTableActivity(enabled: boolean, live: boolean) {
  return useQuery({
    queryKey: ['terrain-tables-activity'] as const,
    queryFn: async ({ signal }) =>
      api.get<TerrainTablesActivity>('/api/observatory/terrain/tables/activity', signal),
    enabled,
    staleTime: live ? 8_000 : 60_000,
    refetchInterval: live ? 10_000 : false,
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
