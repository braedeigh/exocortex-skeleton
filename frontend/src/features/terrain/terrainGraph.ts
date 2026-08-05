/**
 * terrainGraph.ts — pure graph construction + heat math for the Terrain page.
 * Turns the /api/observatory/terrain payload into a force-graph-ready node/
 * edge list: each repo is a root hub, directories are hub nodes (single-child
 * chains collapsed into one labeled node, e.g. "routes/kitchen"), and files
 * are leaves. No layout math here — that's the d3-force sim's job; this
 * module only decides which nodes exist, how they nest, and how hot each one
 * is for a given recency lens.
 */
import type { TerrainData, TerrainFile, TerrainLiveSession, TerrainRepo, TerrainSession } from './api';

export type HeatLens = 'day' | 'week' | 'month';

/** Half-life in seconds for each lens — the exponential decay's "time to fall
 * to half brightness". Touches (and payloads generally) are unix seconds. */
export const LENS_HALF_LIFE_SECONDS: Record<HeatLens, number> = {
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 30 * 24 * 3600,
};

export const HEAT_LENSES: readonly HeatLens[] = ['day', 'week', 'month'];

/**
 * A heat span is either one of the three named lenses or a raw half-life in
 * seconds. The raw form exists for the Observatory backdrop's *breathing*
 * (see breathHalfLife below): three named values can only ever step between
 * three glows, and stepping isn't breathing.
 */
export type HeatSpan = HeatLens | number;

export function halfLifeSeconds(span: HeatSpan): number {
  return typeof span === 'number' ? span : LENS_HALF_LIFE_SECONDS[span];
}

/** The heat bar's ends, in whole days: one day out to one year. The far end
 * grew from a month when the payload stopped being windowed to 90 days — the
 * server now sends every touch in both repos' git history (codestore.py), so
 * the bar can afford a memory as long as the history itself. */
export const HEAT_DAYS_MIN = 1;
export const HEAT_DAYS_MAX = 365;

/** Compact age label — minutes under an hour, hours under a day, then days.
 * One unit ladder the whole way rather than switching to weeks partway, so
 * two ticks on the same key can always be compared by eye. */
export function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * The three labels down the colour key, hottest first, derived from whatever
 * half-life the heat bar is set to — they used to be hardcoded per named
 * lens, which a continuous bar can't be.
 *
 * The middle tick is a QUARTER of the half-life, which is where the ramp is
 * still visibly warm; the bottom is the half-life itself, marked "+" because
 * everything older piles up below it. At a one-day half-life that reproduces
 * the old Day key exactly (now / 6h / 1d+).
 *
 * Prompt that produced it: "generate them from the half life".
 */
export function heatKeyTicks(halfLife: number): [string, string, string] {
  return ['now', formatAge(halfLife / 4), `${formatAge(halfLife)}+`];
}

/**
 * The colour ramp laid along the heat slider's own track, so the control and
 * the legend are one object.
 *
 * The trick is that the track's axis can be read two ways at once. As a
 * *control* it's the half-life you're setting; as a *scale* it's an age axis —
 * position x is "a file touched x days ago", and the colour there is exactly
 * what such a file wears on the map right now. So the bar answers "how far
 * back does the map remember" by showing it rather than naming it, and it
 * restates itself live as you drag: pull the handle right and the whole ramp
 * brightens, because a longer half-life is literally a map that keeps older
 * work lit.
 *
 * Returns sample points, not colours — the ramp itself lives with the canvas
 * that paints it (heatColor in terrainCanvas.ts), and this stays pure maths.
 * `pct` is the position along the track and `t` the 0..1 heat at it, using the
 * same 2^-(age/half_life) decay every node on the map uses.
 *
 * Sampled rather than two-stop because the track is LOGARITHMIC in days while
 * the decay is exponential in days: a straight CSS gradient between the ends
 * would draw a curve the map doesn't have. Twenty-four stops is past the point
 * where the eye can find the seams.
 *
 * Prompt that produced it: "i want the heat map to also be superimposed onto
 * the heat map bar."
 */
export function heatTrackStops(
  halfLifeDays: number,
  minDays: number = HEAT_DAYS_MIN,
  maxDays: number = HEAT_DAYS_MAX,
  samples = 24,
): { pct: number; t: number }[] {
  const ratio = maxDays / minDays;
  return Array.from({ length: samples }, (_, i) => {
    const p = samples > 1 ? i / (samples - 1) : 0; // a lone sample is the near end, not 0/0

    const days = minDays * ratio ** p;
    return {
      pct: p * 100,
      t: halfLifeDays > 0 ? 2 ** (-days / halfLifeDays) : 0,
    };
  });
}

/** Share of the breath cycle spent inhaling — 4 seconds of a 10-second
 * breath, leaving 6 for the exhale. */
export const BREATH_INHALE_FRACTION = 0.4;

/** One full breath. Her pick: slow and deep, not a human 5s rhythm.
 *
 * Lives here rather than in either surface that uses it, because BOTH breathe
 * now — the Observatory backdrop and /terrain's Dynamic heat preset — and two
 * copies of this number is two rhythms that can silently drift apart. It's one
 * breath; the map just has two windows onto it. */
export const BREATH_PERIOD_MS = 10_000;

/** How often a breathing surface repaints — ~7fps. The glow moves slowly
 * enough that more frames buy nothing, and this is ambient motion that has no
 * business costing more than it must. */
export const BREATH_TICK_MS = 150;

/**
 * The backdrop's breath: a half-life that swells from `day` out to `month`
 * and settles back, once per `periodMs`.
 *
 * Three choices in here that matter more than they look:
 *
 * 1. **Cosine, not a sawtooth or a triangle.** The value has to arrive at
 *    both ends with zero velocity or the turn reads as a flinch. This is the
 *    same reason motion is eased and never linear.
 * 2. **Interpolated in LOG space.** Half-life is a multiplicative quantity —
 *    day to month is a 30x span — so a linear lerp would spend most of the
 *    cycle bunched up near `month` and the breath would look lopsided, a slow
 *    swell and an abrupt collapse. In log space each equal slice of the cycle
 *    is an equal *ratio* of memory, which is what the eye actually reads as
 *    even.
 * 3. **Uneven — 4 in, 6 out.** The swell takes 4 seconds of the 10-second
 *    cycle and the settle takes 6, so it's built from TWO half-cosines rather
 *    than one whole one. A longer exhale than inhale is the rhythm that
 *    actually settles a nervous system, and it's the difference between the
 *    map reading as alive and reading as a machine blinking. Both halves are
 *    still cosines, so point 1 holds at every turn.
 *
 *    Prompt that produced it: "make the breathing of the dots by time more
 *    like box breathing. research what kind of breathing to make it. maybe
 *    instead just 4 in 6 out."
 *
 * What it looks like on the map: widening the lens is not uniform
 * brightening. Old files enter the ramp while recent ones barely move — so
 * the map appears to remember further back, and then forget again.
 */
export function breathHalfLife(elapsedMs: number, periodMs = 10_000): number {
  if (!(periodMs > 0)) return LENS_HALF_LIFE_SECONDS.day;
  const phase = ((elapsedMs % periodMs) + periodMs) % periodMs / periodMs;
  // The inhale owns the first 40% of the cycle and rides 0 -> 1; the exhale
  // owns the remaining 60% and rides 1 -> 0. Both are half-cosines, so the
  // value is flat at the top and at both ends of the cycle.
  const u =
    phase < BREATH_INHALE_FRACTION
      ? (1 - Math.cos((phase / BREATH_INHALE_FRACTION) * Math.PI)) / 2
      : (1 + Math.cos(((phase - BREATH_INHALE_FRACTION) / (1 - BREATH_INHALE_FRACTION)) * Math.PI)) / 2;
  const lo = Math.log(LENS_HALF_LIFE_SECONDS.day);
  const hi = Math.log(LENS_HALF_LIFE_SECONDS.month);
  return Math.exp(lo + (hi - lo) * u);
}

/** Slight per-level decay applied when a directory's heat is rolled up from
 * its hottest child — a directory two hubs above a hot file glows dimmer than
 * one right above it. */
export const DIR_DECAY = 0.92;

// ---- the map's two dials: how much time, how many files ------------------------

/** Half-life used to rank files when the count dial has to choose which ones
 * survive. Deliberately the same week half-life the server ranks its own cut
 * by (_TERRAIN_CAP_HALF_LIFE_SEC), so growing the slider past the fetched
 * tier reveals files in the order the server was already keeping them — the
 * map never reshuffles just because a bigger payload arrived. */
export const COUNT_RANK_HALF_LIFE_SECONDS = 7 * 24 * 3600;

export interface TerrainFilter {
  /** Inclusive unix-seconds bounds on which touches count. */
  from: number;
  to: number;
  /** How many file nodes to keep, globally across repos. null = every file. */
  count: number | null;
}

/** Every file the payload holds, before any client-side dial — the
 * denominator in "showing 700 of 3,260". Comes from each repo's honest
 * files_total, so it counts files the server itself cut away. */
export function terrainFileTotal(data: TerrainData): number {
  return data.repos.reduce((sum, repo) => sum + (repo.files_total ?? repo.files.length), 0);
}

/** How many files the payload actually carries right now (≤ terrainFileTotal
 * whenever the server applied a cut) — the ceiling on what the count dial can
 * show without refetching a bigger tier. */
export function terrainFileLoaded(data: TerrainData): number {
  return data.repos.reduce((sum, repo) => sum + repo.files.length, 0);
}

/** Oldest touch anywhere in the payload — the left edge of the date range.
 * Falls back to `to` minus the payload's window when nothing has a timestamp
 * (an empty map still needs a draggable range). */
export function terrainEarliestTouch(data: TerrainData, fallbackTo: number): number {
  let earliest = Infinity;
  for (const repo of data.repos) {
    for (const file of repo.files) {
      for (const ts of file.touches) if (ts < earliest) earliest = ts;
      for (const s of file.sessions) {
        if (typeof s.last === 'number' && s.last < earliest) earliest = s.last;
      }
    }
  }
  if (!Number.isFinite(earliest)) return fallbackTo - (data.window_days || 90) * 86400;
  return earliest;
}

function inRange(ts: number, from: number, to: number): boolean {
  return ts >= from && ts <= to;
}

/**
 * Apply the date range and the file-count dial, returning a payload of the
 * same shape the rest of the pipeline already understands (buildTerrainGraph
 * doesn't need to know these dials exist).
 *
 * Time first, then count — the order matters: narrowing to one week and
 * asking for 200 files should give the 200 hottest files *of that week*, not
 * whichever of the all-time top 200 happen to fall inside it.
 *
 * A file survives the time cut if any of its git touches OR any session's
 * last write lands in range; everything out of range is stripped from the
 * file, so heat, ages, and the session lists all describe the chosen span
 * rather than all time. `files_total` is deliberately NOT recomputed — it
 * stays the honest whole-corpus count the key line reports against.
 */
export function filterTerrainData(
  data: TerrainData,
  filter: TerrainFilter,
  nowSeconds = Date.now() / 1000,
): TerrainData {
  const { from, to, count } = filter;

  interface Ranked { repoIndex: number; file: TerrainFile; rank: number }
  const ranked: Ranked[] = [];

  data.repos.forEach((repo, repoIndex) => {
    for (const file of repo.files) {
      const touches = file.touches.filter((ts) => inRange(ts, from, to));
      // Session stamps are ISO strings; sessionLastSeconds is what makes them
      // comparable to the numeric touches above. A session with no usable
      // stamp is KEPT rather than dropped — attribution ("this agent wrote
      // here") is worth more than the timestamp we failed to parse, and
      // dropping them is what made the agent orbs disappear entirely.
      const sessions = file.sessions.filter((s) => {
        const last = sessionLastSeconds(s.last);
        return last === null || inRange(last, from, to);
      });
      if (touches.length === 0 && sessions.length === 0) continue;
      // Rank against the range's own end, not the wall clock: inside a
      // historical window the "hottest" files are the ones busiest then.
      const ref = Math.min(nowSeconds, to);
      let rank = 0;
      for (const ts of touches) rank += Math.pow(2, -(ref - ts) / COUNT_RANK_HALF_LIFE_SECONDS);
      for (const s of sessions) {
        const last = sessionLastSeconds(s.last);
        if (last !== null) rank += Math.pow(2, -(ref - last) / COUNT_RANK_HALF_LIFE_SECONDS);
      }
      ranked.push({ repoIndex, file: { ...file, touches, sessions }, rank });
    }
  });

  let kept = ranked;
  if (count !== null && count < ranked.length) {
    // Stable within equal rank (sort by path) so the same N files survive
    // across refetches instead of shuffling under her.
    kept = [...ranked]
      .sort((a, b) => b.rank - a.rank || a.file.path.localeCompare(b.file.path))
      .slice(0, count);
  }

  const byRepo = new Map<number, TerrainFile[]>();
  for (const entry of kept) {
    const list = byRepo.get(entry.repoIndex);
    if (list) list.push(entry.file);
    else byRepo.set(entry.repoIndex, [entry.file]);
  }

  return {
    ...data,
    repos: data.repos.map((repo, i) => ({
      ...repo,
      files: (byRepo.get(i) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
    })),
  };
}

export type TerrainNodeKind = 'repo' | 'dir' | 'file' | 'session';

/** What a session orb node carries — identity, not heat (sessions are
 * categorical bodies on the map; only files glow ember). */
export interface OrbSession {
  id: string;
  title: string;
  /** From the payload's top-level sessions array when present; file-level
   * session entries carry no bot, so this may be absent (navigation then
   * falls back to the atlas conv→bot map). */
  bot?: string;
  running: boolean;
  /** Not archived. Only the payload's top-level sessions array knows this, so
   * an orb built purely from file attribution reads as closed. */
  open: boolean;
  /** 'personal' | 'coding' | 'orchestra', or '' when the payload doesn't say. */
  lane: string;
  /** Unix seconds of the session's last activity, best-effort. */
  last: number | null;
  /** How many file nodes its footprint covers. */
  files: number;
}

export interface TerrainNode {
  id: string;
  kind: TerrainNodeKind;
  /** Display label — for collapsed directory chains, the joined segments
   * ("routes/kitchen"); for files, the final path segment; for repos, the
   * repo's name; for session orbs, the session title. */
  label: string;
  parentId: string | null;
  /** Rendered depth (post-collapse) — repo hub is 0; orbs use 0 too. */
  depth: number;
  /** Owning repo — session orbs use '' (they roam across repos and are
   * never hidden by the repo toggles). */
  repoId: string;
  /** Full repo-relative path — only present for file nodes. */
  path?: string;
  /** Raw decayed-touch sum for this node's own lens/heat calc. Always 0 for
   * session orbs — identity, not magnitude. */
  heat: number;
  /** The file payload, for file nodes only (sessions, touches). */
  file?: TerrainFile;
  /** The session payload, for session orb nodes only. */
  session?: OrbSession;
}

export interface TerrainEdge {
  source: string;
  target: string;
  /** 'tree' = parent→child structure (default); 'session' = a weak tether
   * from a session orb to one of its footprint files, so the physics parks
   * the orb amid its own territory without distorting the tree. */
  kind?: 'tree' | 'session';
}

export interface TerrainGraph {
  nodes: TerrainNode[];
  edges: TerrainEdge[];
}

/**
 * A session's `last` as unix seconds, or null if it doesn't have one.
 *
 * The payload mixes units: `files[].touches` are unix seconds (from git),
 * while `files[].sessions[].last` is an ISO-8601 string (from the footprints
 * sidecar). Everything downstream compares the two, so every read of a
 * session's timestamp goes through here. Guarding with `typeof x === 'number'`
 * instead — which is what the code did before — silently discards every
 * session, because the value is always a string in practice.
 */
export function sessionLastSeconds(last: TerrainSession['last']): number | null {
  if (typeof last === 'number') return Number.isFinite(last) ? last : null;
  if (typeof last === 'string') {
    const ms = Date.parse(last);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return null;
}

/** Exponential recency decay: each touch (or session write's `last`) counts
 * for 2^-(age/half_life) — a touch right now scores 1, one half-life old
 * scores 0.5, two half-lives old scores 0.25, etc. */
export function computeFileHeat(file: TerrainFile, lens: HeatSpan, nowSeconds: number): number {
  const halfLife = halfLifeSeconds(lens);
  if (halfLife <= 0) return 0;
  const allTouches: number[] = [...file.touches];
  for (const session of file.sessions) {
    const last = sessionLastSeconds(session.last);
    if (last !== null) allTouches.push(last);
  }
  let heat = 0;
  for (const ts of allTouches) {
    const age = nowSeconds - ts;
    if (!Number.isFinite(age)) continue;
    heat += Math.pow(2, -age / halfLife);
  }
  return heat;
}

/** Saturating 0..1 normalization for color/radius lookup — a single
 * brand-new touch (heat=1) lands at 0.5, two at 0.75, etc., so the ramp
 * never depends on how many files happen to exist in the payload. */
export function normalizeHeat(heat: number): number {
  if (heat <= 0) return 0;
  return 1 - Math.pow(2, -heat);
}

// ---- directory-chain collapsing ------------------------------------------------

interface TrieDir {
  /** Path segments merged into this node so far (e.g. ['routes', 'kitchen']). */
  segments: string[];
  dirs: Map<string, TrieDir>;
  files: TerrainFile[];
}

function newTrieDir(segments: string[]): TrieDir {
  return { segments, dirs: new Map(), files: [] };
}

function buildTrie(files: TerrainFile[]): TrieDir {
  const root = newTrieDir([]);
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const dirParts = parts.slice(0, -1);
    let cur = root;
    for (const part of dirParts) {
      let next = cur.dirs.get(part);
      if (!next) {
        next = newTrieDir([part]);
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.files.push(file);
  }
  return root;
}

/** Walk down while this is a pure passthrough (exactly one child directory,
 * no files of its own) — merging segments — until hitting a branch or a
 * directory that actually holds files. Repo root is never merged away by the
 * caller (it always emits its own hub first). */
function collapse(dir: TrieDir): TrieDir {
  let cur = dir;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const [, child] = [...cur.dirs.entries()][0];
    cur = { segments: [...cur.segments, ...child.segments], dirs: child.dirs, files: child.files };
  }
  return cur;
}

interface BuildCtx {
  repo: TerrainRepo;
  lens: HeatSpan;
  nowSeconds: number;
  nodes: TerrainNode[];
  edges: TerrainEdge[];
}

/** Emits `dir` (already collapsed) as a node under `parentId`, then recurses
 * into its files and child directories. Returns the emitted node's own heat
 * (max of children, decayed one level) so the caller can roll it further up. */
function emitDir(ctx: BuildCtx, dir: TrieDir, parentId: string, depth: number): number {
  const id = `${ctx.repo.id}:dir:${dir.segments.join('/')}`;
  const label = dir.segments.join('/') || ctx.repo.name;
  const node: TerrainNode = {
    id,
    kind: 'dir',
    label,
    parentId,
    depth,
    repoId: ctx.repo.id,
    heat: 0,
  };
  ctx.nodes.push(node);
  ctx.edges.push({ source: parentId, target: id });

  let maxChildHeat = 0;

  for (const file of dir.files) {
    const fileId = `${ctx.repo.id}:file:${file.path}`;
    const heat = computeFileHeat(file, ctx.lens, ctx.nowSeconds);
    ctx.nodes.push({
      id: fileId,
      kind: 'file',
      label: file.path.split('/').filter(Boolean).slice(-1)[0] ?? file.path,
      parentId: id,
      depth: depth + 1,
      repoId: ctx.repo.id,
      path: file.path,
      heat,
      file,
    });
    ctx.edges.push({ source: id, target: fileId });
    maxChildHeat = Math.max(maxChildHeat, heat);
  }

  for (const child of dir.dirs.values()) {
    const collapsedChild = collapse(child);
    const childHeat = emitDir(ctx, collapsedChild, id, depth + 1);
    maxChildHeat = Math.max(maxChildHeat, childHeat);
  }

  const rolled = maxChildHeat * DIR_DECAY;
  node.heat = rolled;
  return rolled;
}

/** Builds the full multi-repo graph for one heat lens. `nowSeconds` is
 * injectable for tests; defaults to the real clock. `opts.orbSessionIds`, when
 * given, restricts which session orbs are emitted — the Observatory backdrop
 * passes its active set so the wallpaper shows only agents that are live right
 * now, not the 90-day footprint backlog. Omitted (the /terrain map, tests) =
 * every footprinted session gets an orb, unchanged. `opts.alwaysOrbIds` is the
 * opposite lever: sessions that get an orb even with no footprint at all (see
 * buildSessionOrbs) — /terrain passes the conversations she has open, so an
 * agent she's watching is on the map before it has touched anything. */
export function buildTerrainGraph(
  data: TerrainData,
  lens: HeatSpan,
  nowSeconds = Date.now() / 1000,
  opts?: { orbSessionIds?: Set<string> | null; alwaysOrbIds?: Set<string> | null },
): TerrainGraph {
  const nodes: TerrainNode[] = [];
  const edges: TerrainEdge[] = [];

  for (const repo of data.repos) {
    const repoId = `repo:${repo.id}`;
    const repoNode: TerrainNode = {
      id: repoId,
      kind: 'repo',
      label: repo.name,
      parentId: null,
      depth: 0,
      repoId: repo.id,
      heat: 0,
    };
    nodes.push(repoNode);

    const trie = buildTrie(repo.files);
    const repoCtx: BuildCtx = { repo, lens, nowSeconds, nodes: [], edges: [] };

    // The repo root's own files (rare — files sitting directly at repo root)
    // and its top-level directories both hang straight off the repo hub.
    let repoMaxHeat = 0;
    for (const file of trie.files) {
      const fileId = `${repo.id}:file:${file.path}`;
      const heat = computeFileHeat(file, lens, nowSeconds);
      repoCtx.nodes.push({
        id: fileId,
        kind: 'file',
        label: file.path.split('/').filter(Boolean).slice(-1)[0] ?? file.path,
        parentId: repoId,
        depth: 1,
        repoId: repo.id,
        path: file.path,
        heat,
        file,
      });
      repoCtx.edges.push({ source: repoId, target: fileId });
      repoMaxHeat = Math.max(repoMaxHeat, heat);
    }
    for (const child of trie.dirs.values()) {
      const collapsedChild = collapse(child);
      const childHeat = emitDir(repoCtx, collapsedChild, repoId, 1);
      repoMaxHeat = Math.max(repoMaxHeat, childHeat);
    }

    repoNode.heat = repoMaxHeat * DIR_DECAY;
    nodes.push(...repoCtx.nodes);
    edges.push(...repoCtx.edges);
  }

  const orbs = buildSessionOrbs(
    nodes,
    data.sessions,
    opts?.orbSessionIds ?? null,
    opts?.alwaysOrbIds ?? null,
  );
  nodes.push(...orbs.nodes);
  edges.push(...orbs.edges);

  return { nodes, edges };
}

export const SESSION_NODE_PREFIX = 'session:';

/**
 * Session orbs: every session with a nonempty footprint (inverted from
 * files[].sessions) becomes a visible body on the map, weakly tethered to
 * each of its files. Title/bot/running/last come from the payload's
 * top-level sessions array when it knows the session; otherwise the
 * file-level entries supply title + last and the orb reads as not running.
 *
 * `alwaysIds` names sessions that get an orb EVEN WITH NO FOOTPRINT. Orbs are
 * built by inverting files[].sessions, so without this a conversation that
 * hasn't touched a file yet — or whose files fell outside the current dials —
 * simply isn't on the map, however plainly open it is. /terrain passes the
 * conversations she has open here, so "open" is enough to earn a body. Such an
 * orb has no tethers and therefore no gravity: the sim parks it at the canvas
 * anchor rather than amid a territory it doesn't have yet.
 */
export function buildSessionOrbs(
  fileNodes: TerrainNode[],
  live: TerrainLiveSession[] | undefined,
  allowedIds: Set<string> | null = null,
  alwaysIds: Set<string> | null = null,
): TerrainGraph {
  const liveById = new Map((live ?? []).map((s) => [s.id, s]));

  // Invert files[].sessions: session id → its footprint file nodes.
  const footprints = new Map<string, { fileIds: string[]; title: string; lastSeen: number | null }>();
  for (const node of fileNodes) {
    if (node.kind !== 'file' || !node.file) continue;
    for (const s of node.file.sessions) {
      let fp = footprints.get(s.id);
      if (!fp) {
        fp = { fileIds: [], title: s.title, lastSeen: null };
        footprints.set(s.id, fp);
      }
      fp.fileIds.push(node.id);
      const last = sessionLastSeconds(s.last);
      if (last !== null) fp.lastSeen = Math.max(fp.lastSeen ?? -Infinity, last);
    }
  }

  const nodes: TerrainNode[] = [];
  const edges: TerrainEdge[] = [];
  for (const [sessionId, fp] of footprints) {
    if (fp.fileIds.length === 0) continue;
    // Backdrop restricts orbs to its active set; the objective map passes null
    // and keeps every footprinted session.
    if (allowedIds && !allowedIds.has(sessionId)) continue;
    const meta = liveById.get(sessionId);
    const isoLast = meta?.last ? Date.parse(meta.last) : NaN;
    const orbId = `${SESSION_NODE_PREFIX}${sessionId}`;
    nodes.push({
      id: orbId,
      kind: 'session',
      label: meta?.title || fp.title || sessionId,
      parentId: null,
      depth: 0,
      repoId: '',
      heat: 0,
      session: {
        id: sessionId,
        title: meta?.title || fp.title || sessionId,
        bot: meta?.bot,
        running: meta?.running === true,
        open: meta?.open === true,
        lane: meta?.lane ?? '',
        last: Number.isFinite(isoLast) ? isoLast / 1000 : fp.lastSeen,
        files: fp.fileIds.length,
      },
    });
    for (const fileId of fp.fileIds) {
      edges.push({ source: orbId, target: fileId, kind: 'session' });
    }
  }

  // Footprint-less orbs, second pass: an open conversation the inversion above
  // never saw. It needs identity to be drawable at all, so it's emitted only
  // when the payload's sessions array knows it — no title, no orb.
  for (const sessionId of alwaysIds ?? []) {
    if (footprints.has(sessionId)) continue;
    if (allowedIds && !allowedIds.has(sessionId)) continue;
    const meta = liveById.get(sessionId);
    if (!meta) continue;
    const isoLast = meta.last ? Date.parse(meta.last) : NaN;
    nodes.push({
      id: `${SESSION_NODE_PREFIX}${sessionId}`,
      kind: 'session',
      label: meta.title || sessionId,
      parentId: null,
      depth: 0,
      repoId: '',
      heat: 0,
      session: {
        id: sessionId,
        title: meta.title || sessionId,
        bot: meta.bot,
        running: meta.running === true,
        open: meta.open === true,
        lane: meta.lane ?? '',
        last: Number.isFinite(isoLast) ? isoLast / 1000 : null,
        files: 0,
      },
    });
  }
  return { nodes, edges };
}

/**
 * Which file nodes moved between two payloads — a file counts as changed
 * when its newest touch (raw touches ∪ session writes) advanced, or when it
 * is new outright. Returns node ids (`<repo>:file:<path>`), ready for the
 * canvas's one-shot flash so live-mode refetches light up exactly what a
 * working session just wrote.
 */
export function changedFileIds(prev: TerrainData, next: TerrainData): Set<string> {
  const prevLast = new Map<string, number | null>();
  for (const repo of prev.repos) {
    for (const file of repo.files) prevLast.set(`${repo.id}:file:${file.path}`, fileLastTouch(file));
  }
  const changed = new Set<string>();
  for (const repo of next.repos) {
    for (const file of repo.files) {
      const id = `${repo.id}:file:${file.path}`;
      const last = fileLastTouch(file);
      if (last === null) continue;
      if (!prevLast.has(id)) {
        changed.add(id); // brand-new on the map
        continue;
      }
      const before = prevLast.get(id);
      if (before == null || last > before) changed.add(id);
    }
  }
  return changed;
}

/** The hottest N file nodes (directories are always labeled separately at
 * readable zoom, so they're excluded here) — used to pick which nodes get a
 * direct relative-age label. */
export function topHeatFiles(nodes: TerrainNode[], n = 8): TerrainNode[] {
  return nodes
    .filter((node) => node.kind === 'file' && node.heat > 0)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, n);
}

/** Compact relative age for a unix-seconds timestamp — "just now", "2h", "3d",
 * no "ago" suffix (used for the hottest-file direct labels, where space is
 * tight and the ramp color already says "recent"). */
export function relativeAge(unixSeconds: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, nowMs / 1000 - unixSeconds);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / (86400 * 30))}mo`;
}

/** The most recent touch on a file node — its own touches plus every
 * session's `last` write, same union computeFileHeat sums over. */
export function fileLastTouch(file: TerrainFile): number | null {
  const all: number[] = [...file.touches];
  for (const s of file.sessions) {
    const last = sessionLastSeconds(s.last);
    if (last !== null) all.push(last);
  }
  if (all.length === 0) return null;
  return Math.max(...all);
}

/**
 * The same footprint as sessionFootprint, but as a LIST ordered by how
 * recently THIS session touched each file — newest first, ties broken by node
 * id so the order is stable across refetches instead of shuffling under her.
 *
 * It exists because the canvas captions a spotlit agent's files, and below
 * readable zoom it can only afford to name a handful: "a handful" has to mean
 * the ones it worked on last, not an arbitrary slice. Files the session has no
 * usable timestamp for sort to the back rather than dropping out — attribution
 * outlives a stamp we failed to parse (same rule filterTerrainData follows).
 */
export function sessionFootprintByRecency(nodes: TerrainNode[], sessionId: string): string[] {
  const scored: { id: string; last: number }[] = [];
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file) continue;
    const s = node.file.sessions.find((x) => x.id === sessionId);
    if (!s) continue;
    scored.push({ id: node.id, last: sessionLastSeconds(s.last) ?? -Infinity });
  }
  scored.sort((a, b) => b.last - a.last || a.id.localeCompare(b.id));
  return scored.map((e) => e.id);
}

/** Node ids belonging to one session's footprint — every file node it
 * touched, so the canvas can ring them and dim everything else. */
export function sessionFootprint(nodes: TerrainNode[], sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file) continue;
    if (node.file.sessions.some((s: TerrainSession) => s.id === sessionId)) ids.add(node.id);
  }
  return ids;
}

// ---- focus rings: how one session touched a file ------------------------------

/** How the focused session touched a file, strongest signal first: 'created'
 * if it wrote the file into existence fresh, else 'modified' if it wrote it at
 * all (a file it both read and changed reads as changed), else 'read' if it
 * only read it (or is attributed with no write count); null when the session
 * never touched it. Drives the room backdrop's focus rings — green = created,
 * purple = modified, white = read. */
export type FileTouchKind = 'created' | 'modified' | 'read';

export function sessionFileTouch(file: TerrainFile, sessionId: string): FileTouchKind | null {
  const s = file.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  if ((s.creates ?? 0) > 0) return 'created';
  return (s.writes ?? 0) > 0 ? 'modified' : 'read';
}

/** One day, the window a "freshly created" file glows green in its own dot. */
export const CREATED_FRESH_WINDOW_SECONDS = 24 * 3600;

/**
 * Whether a file reads as *freshly created* — regardless of which agent is in
 * focus. True when some session wrote it into existence (creates>0) and did so
 * within `windowSeconds`. The footprints sidecar carries no standalone
 * creation stamp, so the creating session's last touch is the proxy: a file
 * just written won't have drifted from its birth by more than the window.
 * Drives the backdrop's green dot fill (her 07-27 call: green dot anywhere it's
 * new, the purple ring reserved for the focused agent's own working set).
 */
export function fileCreatedWithin(
  file: TerrainFile,
  windowSeconds: number,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  for (const s of file.sessions) {
    if ((s.creates ?? 0) <= 0) continue;
    const last = sessionLastSeconds(s.last);
    if (last !== null && nowSeconds - last <= windowSeconds) return true;
  }
  return false;
}

/**
 * node id → how the STRONGEST of `sessionIds` touched that file. The
 * many-agents form of sessionTouchRings below: /terrain rings every file the
 * shown agents have read or written, all at once, so a file touched by three
 * of them still wears exactly one ring. Strongest signal wins — created beats
 * modified beats read — because a ring can only say one thing, and the biggest
 * claim on a file is the truest one to show.
 *
 * Prompt that produced it: "i am wanting rings around anything that has been
 * read or written by these agents ... purple = written, white = read."
 */
const RING_RANK: Record<FileTouchKind, number> = { read: 0, modified: 1, created: 2 };

export function agentTouchRings(
  nodes: TerrainNode[],
  sessionIds: ReadonlySet<string>,
): Map<string, FileTouchKind> {
  const rings = new Map<string, FileTouchKind>();
  if (sessionIds.size === 0) return rings;
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file) continue;
    let best: FileTouchKind | null = null;
    for (const s of node.file.sessions) {
      if (!sessionIds.has(s.id)) continue;
      const kind = sessionFileTouch(node.file, s.id);
      if (kind && (best === null || RING_RANK[kind] > RING_RANK[best])) best = kind;
    }
    if (best) rings.set(node.id, best);
  }
  return rings;
}

/** node id → created/modified/read for every file the given session touched —
 * the ring set the focused-agent backdrop draws around the agent's working set. */
export function sessionTouchRings(nodes: TerrainNode[], sessionId: string): Map<string, FileTouchKind> {
  const rings = new Map<string, FileTouchKind>();
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file) continue;
    const kind = sessionFileTouch(node.file, sessionId);
    if (kind) rings.set(node.id, kind);
  }
  return rings;
}
