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
import { foreignKeyEdges } from './tableNodes';

export type HeatLens = 'day' | 'week' | 'month';

/**
 * WINDOW vs HALF-LIFE — the two units the heat runs in, and the seam between.
 *
 * What she sets (the Heat bar's thumb, the presets, the breath) is a WINDOW:
 * "lit for a day", "lit for a month". The dot on the bar is the EDGE of the
 * colour — where the glow has run out, not where it's half. What the decay
 * math takes is a HALF-LIFE: the time for a touch to fall to half strength.
 * The two meet here: a window is WINDOW_HALF_LIVES half-lives long, so by its
 * edge a touch is down to 2^-3 = an eighth, which is where hue over ash stops
 * being visible (see terrainCanvas.ts glowAlpha). Fully lit today, half lit a
 * third of the way, gone at the dot.
 *
 * Three is a judgment, not a law: two would leave a quarter at the edge (a
 * faint hue still showing past the dot), four would pull the last visible
 * colour to well inside the dot. Three lands it right at the dot.
 *
 * Everything the slider or the breath produces is a window; convert with
 * windowToHalfLife() before it meets computeFileHeat / heatThreads. The
 * named presets (LENS_HALF_LIFE_SECONDS) are genuine half-lives for callers
 * that pass a HeatLens by name, and the breath's day..month range is read as
 * windows by the surfaces that run it.
 *
 * Prompt that produced it: "i want the dot to be the edge of the color, not
 * for the color to trail after it" → "last visible color right at the dot."
 */
export const WINDOW_HALF_LIVES = 3;

/** A window (what she set) → the half-life the decay runs on. */
export function windowToHalfLife(windowSeconds: number): number {
  return windowSeconds / WINDOW_HALF_LIVES;
}

/**
 * The GOLD channel's DEFAULT window: a file is gold if it actually RAN inside
 * it. One day — "did this code run today" — which is where the map's Active
 * bar opens and what any surface that doesn't set a window of its own gets.
 *
 * It is a default and no longer a constant of the map: the Active bar owns
 * gold's window and runs it from five minutes to a week (activeScale.ts), the
 * way the Heat bar owns ember's. Under Dynamic gold takes its own breath
 * instead (goldBreathWindow below): five minutes out to a day and back,
 * ALTERNATING with ember's day-to-month breath — see alternatingBreath. Same
 * shape of decay as ember either way: fully lit just ran, half a third of the
 * way, gone at the edge.
 */
export const RUN_WINDOW_SECONDS = 24 * 3600;
export const RUN_HALF_LIFE_SECONDS = windowToHalfLife(RUN_WINDOW_SECONDS);

/**
 * The gold breath's range. The floor is five minutes, not the minute she
 * named, and the sensor is why: runtime_sensor.py stamps a run into a
 * FIVE-MINUTE bucket (BUCKET_SEC), so "ran in the last minute" would be true
 * for a file only when its bucket happened to start inside that minute — one
 * cycle in five — and the map would flicker at the bottom of every breath.
 * Five minutes is the sensor's honest resolution; the ceiling is the fixed
 * window above, so the top of the gold breath is exactly what a fixed preset
 * shows. Under the breath gold RESTS at the floor, not the ceiling — see
 * alternatingBreath for why.
 */
export const GOLD_BREATH_SECONDS = { min: 300, max: RUN_WINDOW_SECONDS } as const;

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
 * The three labels down the colour key, hottest first, derived from the
 * WINDOW the heat bar is set to: now at the top, the window's midpoint, and
 * its edge at the bottom — the age at which the colour has run out. No "+"
 * on the edge any more: it isn't a floor everything older piles up under,
 * it's where the ramp ends.
 */
export function heatKeyTicks(windowSeconds: number): [string, string, string] {
  return ['now', formatAge(windowSeconds / 2), formatAge(windowSeconds)];
}

/**
 * The colour ramp laid along the heat slider's own track, so the control and
 * the legend are one object — and the thumb is the EDGE of the colour.
 *
 * The track's axis reads two ways at once. As a *control* it's the window
 * you're setting; as a *scale* it's an age axis — position x is "a file
 * touched x days ago", and the colour there is what such a file wears on the
 * map right now. The fill runs hot at the near end, decays across the window
 * on the same 2^-(age/half_life) curve every node uses (half_life =
 * window / WINDOW_HALF_LIVES), and stops at the thumb: everything older than
 * the window is drawn at t = 0, i.e. ash. On the map a file just past the
 * edge is at an eighth, which the eye already reads as ash; the bar rounds
 * that last sliver to zero so the dot is a clean edge, and the 28px thumb
 * sits over the seam. Drag right and the fill lengthens — a longer memory,
 * shown rather than named.
 *
 * Returns sample points, not colours — the ramp itself lives with the canvas
 * that paints it (heatColor in terrainCanvas.ts), and this stays pure maths.
 * `pct` is the position along the track and `t` the 0..1 heat at it.
 *
 * Sampled rather than two-stop because the track is LOGARITHMIC in days while
 * the decay is exponential in days: a straight CSS gradient between the ends
 * would draw a curve the map doesn't have. Twenty-four stops is past the point
 * where the eye can find the seams.
 */
export function heatTrackStops(
  windowDays: number,
  minDays: number = HEAT_DAYS_MIN,
  maxDays: number = HEAT_DAYS_MAX,
  samples = 24,
): { pct: number; t: number }[] {
  const ratio = maxDays / minDays;
  const halfLifeDays = windowToHalfLife(windowDays);
  return Array.from({ length: samples }, (_, i) => {
    const p = samples > 1 ? i / (samples - 1) : 0; // a lone sample is the near end, not 0/0

    const days = minDays * ratio ** p;
    return {
      pct: p * 100,
      t: windowDays > 0 && days <= windowDays ? 2 ** (-days / halfLifeDays) : 0,
    };
  });
}

/** Share of the breath cycle spent inhaling — 4 seconds of a 10-second
 * breath, leaving 6 for the exhale. */
export const BREATH_INHALE_FRACTION = 0.4;

/** One full breath. Her pick: slow and deep, not a human 5s rhythm.
 *
 * The breath's value is a WINDOW (a day out to a month — see windowToHalfLife
 * at the top of this file); the surfaces that run it convert before the
 * decay sees it. breathHalfLife keeps its name from when the two units were
 * one. Gold breathes too, on its own range — see goldBreathWindow.
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
  return breathSpan(elapsedMs, periodMs, LENS_HALF_LIFE_SECONDS.day, LENS_HALF_LIFE_SECONDS.month);
}

/**
 * The gold breath's SHAPE: five minutes swelling out to a day over the inhale
 * and easing back over the exhale — the same motion as ember's breath, on
 * gold's own range. It starts and ends at its floor, so the bottom of the
 * breath is gold's quiet state (only what ran in the last five minutes is
 * lit) and the top is the fixed preset's question (what ran today).
 *
 * On its own this never runs; alternatingBreath() below hands the clock to
 * one fire at a time.
 */
export function goldBreathWindow(elapsedMs: number, periodMs = 10_000): number {
  return breathSpan(elapsedMs, periodMs, GOLD_BREATH_SECONDS.min, GOLD_BREATH_SECONDS.max);
}

/** Which fire the current breath belongs to. */
export type BreathTurn = 'ember' | 'gold';

/**
 * THE ALTERNATING BREATH — the two fires take turns, and each rests at its
 * SMALLEST. One full cycle (BREATH_PERIOD_MS) belongs to ember: its window
 * swells from a day out to a month and settles back while gold rests at five
 * minutes. The next cycle belongs to gold: its window swells from five
 * minutes out to a day and settles back while ember rests at ITS day. Then
 * ember again. Her call, after seeing them breathe together: "have one
 * breath be the time of editing, then the other breath be the time of the
 * last activated, and then have them alternate rather than both be active at
 * the same time".
 *
 * Why gold rests at five minutes and not at its day: a day is gold's
 * LARGEST window, so resting there meant the map stayed fully yellow for the
 * whole of ember's turn, while red glowed up around it. Her correction:
 * "change it such that when the red is at its smallest, the yellow is at its
 * largest. Currently yellow is off kilter and stays yellow in half of the
 * cycle while the red is glowing up". With both resting small, only one
 * colour blooms at a time: yellow is at its fullest at the top of gold's
 * turn, exactly when red is at its smallest, and yellow is quiet while red
 * reaches back.
 *
 * The handoff is seamless by construction: both breaths START and END at
 * their rest, so at the moment the clock passes from one fire to the other
 * nothing on the map or the bar jumps — the thumb comes to rest at the left
 * as the gold ring begins to move out from the left, and vice versa. (Gold's
 * rest differs from the fixed preset's day, so entering or leaving Dynamic
 * moves the ring — the same jump the thumb already makes.)
 *
 * What it looks like: the map remembers back a month of edits and forgets
 * again; then what is executing right now widens to what ran today and
 * narrows again; then it remembers again. One question at a time, in red,
 * then in gold.
 */
export function alternatingBreath(
  elapsedMs: number,
  periodMs = BREATH_PERIOD_MS,
): { ember: number; gold: number; turn: BreathTurn } {
  const rest = { ember: LENS_HALF_LIFE_SECONDS.day, gold: GOLD_BREATH_SECONDS.min };
  if (!(periodMs > 0)) return { ...rest, turn: 'ember' };
  const two = 2 * periodMs;
  const inPair = ((elapsedMs % two) + two) % two;
  const within = inPair % periodMs;
  if (inPair < periodMs) return { ember: breathHalfLife(within, periodMs), gold: rest.gold, turn: 'ember' };
  return { ember: rest.ember, gold: goldBreathWindow(within, periodMs), turn: 'gold' };
}

/** One breath cycle mapped onto a range, in LOG space (an hour matters more
 * against a day than against a month). The inhale owns the first 40% of the
 * cycle and rides lo -> hi; the exhale owns the remaining 60% and rides back.
 * Both are half-cosines, so the value is flat at the top and at both ends. */
export function breathSpan(elapsedMs: number, periodMs: number, lo: number, hi: number): number {
  if (!(periodMs > 0)) return lo;
  const phase = ((elapsedMs % periodMs) + periodMs) % periodMs / periodMs;
  const u =
    phase < BREATH_INHALE_FRACTION
      ? (1 - Math.cos((phase / BREATH_INHALE_FRACTION) * Math.PI)) / 2
      : (1 + Math.cos(((phase - BREATH_INHALE_FRACTION) / (1 - BREATH_INHALE_FRACTION)) * Math.PI)) / 2;
  const llo = Math.log(lo);
  const lhi = Math.log(hi);
  return Math.exp(llo + (lhi - llo) * u);
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
  /** Files kept whatever the dials say, as `<repo>:file:<path>` ids — the dots
   * a journey replay needs on the map even if nothing else would show them. */
  pinned?: ReadonlySet<string>;
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

/** Oldest run anywhere in the payload — how far back the Active bar's "All
 * time" reaches. Null when nothing has run at all. That's often the honest
 * answer: runs are Python-only, and the sensor keeps only each file's last 50
 * five-minute buckets (routes/terrain.py), so "all time" here means "as far
 * back as the run record goes", which can be hours rather than months. */
export function terrainEarliestRun(data: TerrainData): number | null {
  let earliest = Infinity;
  for (const repo of data.repos) {
    for (const file of repo.files) {
      for (const ts of file.ran ?? []) if (ts < earliest) earliest = ts;
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
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
 * The date range NEVER removes a file. Out-of-range touches are stripped, and
 * an out-of-range session keeps its attribution with its stamp blanked, so
 * heat and ages describe the chosen span — but the node stays in the graph,
 * cold and empty-handed. A file with nothing left in range is then hidden by
 * the canvas rather than deleted from it (filesOutsideRange below, joined into
 * the one hidden set in TerrainPage): the dots go, the layout doesn't move,
 * and dragging the handles back brings them home to the same spots.
 *
 * Deleting them is what it used to do, and it meant every drag of a date
 * handle tore down the graph and re-ran the force layout over a different set
 * of bodies — the map rearranged itself under her, which is the one thing a
 * map must never do.
 *
 * Owner, 2026-09-19: "i want it to remove the dots but i don't want it to
 * rearrange everything, as if they were still there but just not visible."
 *
 * The COUNT dial still removes files — that one is "draw fewer bodies", which
 * is a different question from "show me this span". `files_total` is
 * deliberately NOT recomputed — it stays the honest whole-corpus count the key
 * line reports against.
 */
export function filterTerrainData(
  data: TerrainData,
  filter: TerrainFilter,
  nowSeconds = Date.now() / 1000,
): TerrainData {
  const { from, to, count, pinned } = filter;

  interface Ranked { repoIndex: number; file: TerrainFile; rank: number; pin: boolean }
  const ranked: Ranked[] = [];

  data.repos.forEach((repo, repoIndex) => {
    for (const file of repo.files) {
      const pin = pinned?.has(`${repo.id}:file:${file.path}`) ?? false;
      const touches = file.touches.filter((ts) => inRange(ts, from, to));
      // Session stamps are ISO strings; sessionLastSeconds is what makes them
      // comparable to the numeric touches above. A session with no usable
      // stamp is KEPT rather than dropped — attribution ("this agent wrote
      // here") is worth more than the timestamp we failed to parse, and
      // dropping them is what made the agent orbs disappear entirely.
      // An out-of-range session keeps its row and loses its stamp. Blanking
      // `last` is what takes it out of the heat sums (they skip a null) while
      // leaving the agent's tether to this file in the graph — so narrowing the
      // dates re-lights the map without changing which bodies or edges exist,
      // and the layout has no reason to move.
      const sessions = file.sessions.map((s) => {
        const last = sessionLastSeconds(s.last);
        return last !== null && !inRange(last, from, to) ? { ...s, last: null } : s;
      });
      const kept: TerrainFile = { ...file, touches, sessions };
      // Synthetic sub-buckets (the pond tile's days) obey the date dial too —
      // a range narrowed to one week should empty the tile's other columns,
      // not keep drawing a month the dial just excluded.
      if (file.days) {
        kept.days = file.days.map((d) => ({ ...d, touches: d.touches.filter((ts) => inRange(ts, from, to)) }));
      }
      // Rank against the range's own end, not the wall clock: inside a
      // historical window the "hottest" files are the ones busiest then.
      const ref = Math.min(nowSeconds, to);
      let rank = 0;
      for (const ts of touches) rank += Math.pow(2, -(ref - ts) / COUNT_RANK_HALF_LIFE_SECONDS);
      for (const s of sessions) {
        const last = sessionLastSeconds(s.last);
        if (last !== null) rank += Math.pow(2, -(ref - last) / COUNT_RANK_HALF_LIFE_SECONDS);
      }
      ranked.push({ repoIndex, file: kept, rank, pin });
    }
  });

  let kept = ranked;
  if (count !== null && count < ranked.length) {
    // Stable within equal rank (sort by path) so the same N files survive
    // across refetches instead of shuffling under her. Pinned files ride
    // along outside the count — they're there because a replay asked.
    kept = [...ranked]
      .sort((a, b) => b.rank - a.rank || a.file.path.localeCompare(b.file.path))
      .filter((r, i) => i < count || r.pin);
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

/**
 * The files with nothing inside the date range — the dots the range hides.
 *
 * Read off the payload BEFORE filterTerrainData strips it, because the
 * question is "did anything happen in this span", and the stripped copy has
 * already thrown away the evidence either way. A file with no timestamps at
 * all anywhere is NOT hidden: there's nothing to judge it by, and the same
 * rule elsewhere in this file says attribution outlives a stamp we couldn't
 * parse. The pond tile is never hidden — it's the journal's one landmark, and
 * the range reaches inside it to empty its day columns instead.
 *
 * Returns ids to hide rather than a smaller payload, on purpose: joined with
 * the heat and activity cuts into the one set the canvas paints around
 * (terrainCanvas.ts setHiddenFiles), so every time filter on this page hides
 * dots and none of them can move the layout.
 */
export function filesOutsideRange(data: TerrainData, from: number, to: number): Set<string> {
  const hidden = new Set<string>();
  for (const repo of data.repos) {
    for (const file of repo.files) {
      if (file.days) continue; // the pond tile is a landmark, not a dot to sort
      let anyStamp = false;
      let inside = false;
      for (const ts of file.touches) {
        anyStamp = true;
        if (inRange(ts, from, to)) inside = true;
      }
      for (const session of file.sessions) {
        const last = sessionLastSeconds(session.last);
        if (last === null) continue;
        anyStamp = true;
        if (inRange(last, from, to)) inside = true;
      }
      if (anyStamp && !inside) hidden.add(`${repo.id}:file:${file.path}`);
    }
  }
  return hidden;
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
  /** The same decayed sum, but over the file's RUN buckets rather than edits
   * — when this code actually executed, on the fixed one-day run window.
   * Drives the gold body: "this ran today". Absent on nodes that never ran
   * on record, which is most of the map (and every non-Python file). */
  runHeat?: number;
  /** The file payload, for file nodes only (sessions, touches). */
  file?: TerrainFile;
  /** Heat per synthetic sub-bucket, parallel to `file.days` — only ever on
   * the pond tile. Computed with the SAME lens as everything else, so the
   * days inside the tile breathe with the map. */
  dayHeats?: number[];
  /** The session payload, for session orb nodes only. */
  session?: OrbSession;
}

export interface TerrainEdge {
  source: string;
  target: string;
  /** 'tree' = parent→child structure (default); 'session' = a weak tether
   * from a session orb to one of its footprint files, so the physics parks
   * the orb amid its own territory without distorting the tree; 'fk' = a
   * foreign key, from the table that holds it to the table it points at
   * (tableNodes.ts). */
  kind?: 'tree' | 'session' | 'fk';
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

/** The same decayed-touch sum for one of a file's synthetic sub-buckets (the
 * pond tile's days) — kept identical to computeFileHeat's decay so a day
 * inside the tile breathes on exactly the lens the rest of the map is on. */
export function bucketHeat(touches: number[], lens: HeatSpan, nowSeconds: number): number {
  const halfLife = halfLifeSeconds(lens);
  if (halfLife <= 0) return 0;
  let heat = 0;
  for (const ts of touches) {
    const age = nowSeconds - ts;
    if (Number.isFinite(age)) heat += Math.pow(2, -age / halfLife);
  }
  return heat;
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
  /** Half-life the GOLD (run) channel decays on — from the fixed day, or the
   * gold breath. See RUN_WINDOW_SECONDS / goldBreathWindow. */
  runHalfLife: number;
  nowSeconds: number;
  nodes: TerrainNode[];
  edges: TerrainEdge[];
}

/** Emits `dir` (already collapsed) as a node under `parentId`, then recurses
 * into its files and child directories. Returns the emitted node's own heat
 * (max of children, decayed one level) so the caller can roll it further up.
 *
 * `prefix` is the full path of the parent directory, '' at the repo root.
 * The ID is built from the WHOLE path and the LABEL only from this node's
 * collapsed chain, and those two have to stay different things. `segments`
 * holds just the run merged into this node ('src', or 'routes/kitchen'), which
 * is the right thing to show and a disastrous thing to identify by: every
 * directory named `src` anywhere in the tree hashed to one id, so the graph
 * handed back more nodes than it had distinct ids. Everything downstream
 * assumes an id is one node — the edges for all four `src` folders resolved
 * onto whichever was built last, orphaning the others, and setGraph's
 * "nothing moved, just repaint" test (`nodes.length === prev.size`, prev being
 * a Map) could never be true, so the force layout was rebuilt from scratch on
 * every breath tick instead of holding still. */
function emitDir(ctx: BuildCtx, dir: TrieDir, parentId: string, depth: number, prefix: string): number {
  const chain = dir.segments.join('/');
  const path = prefix ? `${prefix}/${chain}` : chain;
  const id = `${ctx.repo.id}:dir:${path}`;
  const label = chain || ctx.repo.name;
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
      runHeat: computeRunHeat(file, ctx.nowSeconds, ctx.runHalfLife),
      file,
      dayHeats: file.days?.map((d) => bucketHeat(d.touches, ctx.lens, ctx.nowSeconds)),
    });
    ctx.edges.push({ source: id, target: fileId });
    maxChildHeat = Math.max(maxChildHeat, heat);
  }

  for (const child of dir.dirs.values()) {
    const collapsedChild = collapse(child);
    const childHeat = emitDir(ctx, collapsedChild, id, depth + 1, path);
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
  opts?: {
    orbSessionIds?: Set<string> | null;
    alwaysOrbIds?: Set<string> | null;
    /** Half-life for the GOLD (run) channel. Omitted = the fixed one-day
     * window; the breathing surfaces pass windowToHalfLife(goldBreathWindow). */
    runHalfLife?: number;
  },
): TerrainGraph {
  const nodes: TerrainNode[] = [];
  const edges: TerrainEdge[] = [];
  const runHalfLife = opts?.runHalfLife ?? RUN_HALF_LIFE_SECONDS;

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
    const repoCtx: BuildCtx = { repo, lens, runHalfLife, nowSeconds, nodes: [], edges: [] };

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
        runHeat: computeRunHeat(file, nowSeconds, runHalfLife),
        file,
        dayHeats: file.days?.map((d) => bucketHeat(d.touches, lens, nowSeconds)),
      });
      repoCtx.edges.push({ source: repoId, target: fileId });
      repoMaxHeat = Math.max(repoMaxHeat, heat);
    }
    for (const child of trie.dirs.values()) {
      const collapsedChild = collapse(child);
      const childHeat = emitDir(repoCtx, collapsedChild, repoId, 1, '');
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

  // Foreign keys: a line between two tables, when the map carries tables.
  edges.push(...foreignKeyEdges(nodes));

  return { nodes, edges };
}

/** One edge as a string, for set membership. Same shape on both sides of the
 * comparison in graphUnchanged, which is the only thing that matters. */
export function edgeKey(source: string, target: string): string {
  return `${source}\n${target}`;
}

/**
 * Is this rebuilt graph the SAME SHAPE as the one on screen — same bodies, same
 * springs, only the heat moved?
 *
 * This is the question the whole breath rests on. The Observatory backdrop
 * rebuilds the graph ~7 times a second so the heat lens can swell and settle,
 * and every one of those rebuilds is meant to be a repaint and nothing more:
 * same nodes, so the force layout is left alone and the map holds still while
 * its glow moves. Answer it wrong in the false direction and the engine throws
 * the layout away and re-runs the physics from scratch on every tick, which at
 * a few thousand nodes is tens of milliseconds of main thread, forever — the
 * page goes sluggish and the map never even settles, because it gets re-warmed
 * before it can.
 *
 * It lives out here, and not inline in the engine, precisely because that
 * happened: the test was one expression in terrainCanvas.ts, which needs a real
 * canvas to run and so is untested by design, and it sat inverted for weeks
 * with nothing able to catch it. Out here it is a pure function over two sets
 * and two arrays, and the tests hold it to its promise.
 *
 * Comparison is against the id/key SETS of the live graph rather than the node
 * list, so it costs one lookup per node instead of a scan per node. Duplicate
 * ids in `nodes` therefore make it answer false — a lie in the safe direction:
 * a full rebuild is correct and slow, where a wrong "unchanged" would update
 * some bodies and silently strand others.
 */
export function graphUnchanged(
  prevNodeIds: ReadonlySet<string>,
  prevEdgeKeys: ReadonlySet<string>,
  nodes: readonly TerrainNode[],
  edges: readonly TerrainEdge[],
): boolean {
  if (nodes.length !== prevNodeIds.size || edges.length !== prevEdgeKeys.size) return false;
  for (const n of nodes) if (!prevNodeIds.has(n.id)) return false;
  for (const e of edges) if (!prevEdgeKeys.has(edgeKey(e.source, e.target))) return false;
  return true;
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

/**
 * RUN heat — the GOLD channel: the same exponential decay computeFileHeat
 * runs, but over the file's run buckets (runtime_sensor.py, via `ran` on the
 * payload) and on the fixed one-day run window rather than the slider's.
 *
 * Kept as its own sum because the two say different things and the map draws
 * them in different colours: heat is the red ramp (this file was EDITED, per
 * git), run is the gold one (this code EXECUTED today). A file can be hot on
 * one and cold on the other — a route that serves every click but hasn't
 * been edited in a month is pure gold; a file rewritten this morning that
 * nothing has called yet is pure red — and that contrast is the point.
 *
 * The buckets are five minutes wide, so a file that runs constantly carries
 * one touch per five minutes; a dozen buckets in the last hour sum well past
 * one and saturate the normaliser, which is right: "running all the time" is
 * as gold as gold gets.
 */
export function computeRunHeat(
  file: TerrainFile,
  nowSeconds: number,
  halfLife: number = RUN_HALF_LIFE_SECONDS,
): number {
  if (!(halfLife > 0) || !file.ran?.length) return 0;
  let heat = 0;
  for (const ts of file.ran) {
    const age = nowSeconds - ts;
    if (Number.isFinite(age) && age >= 0) heat += Math.pow(2, -age / halfLife);
  }
  return heat;
}

/** How long an agent's write stays at FULL strength before it starts fading —
 * her call: "an hour is the brightest". */
export const WRITE_PEAK_SECONDS = 3600;

/** ...and when it has faded out entirely: "by 24 it's dark like the rest".
 * Same 24h the created-green window uses, so the map has one freshness day. */
export const WRITE_FRESH_WINDOW_SECONDS = 24 * 3600;

/**
 * Seconds since an agent last WROTE this file, or null if none ever did.
 *
 * Honesty note, and it is load-bearing: the footprints sidecar stamps ONE
 * `last` per (session, file) — the session's most recent touch of that file of
 * ANY kind, read or write (see scripts/extract_footprints.py's `_aggregate`).
 * So this is "a session that wrote this file last touched it N seconds ago",
 * and the error runs one way only: a write can look FRESHER than it was, never
 * staler, bounded by the length of the conversation. Sessions with no writes
 * are skipped outright, so a pure reader never counts here.
 */
export function fileLastAgentWrite(
  file: TerrainFile,
  nowSeconds: number = Date.now() / 1000,
): number | null {
  let newest: number | null = null;
  for (const s of file.sessions) {
    if ((s.writes ?? 0) <= 0) continue;
    const last = sessionLastSeconds(s.last);
    if (last === null) continue;
    if (newest === null || last > newest) newest = last;
  }
  return newest === null ? null : Math.max(0, nowSeconds - newest);
}

/**
 * A write's freshness, 1 → 0: full for the first hour, then falling away to
 * nothing at 24h.
 *
 * The falloff is LOGARITHMIC over that span, not linear, for the same reason
 * breathHalfLife interpolates in log space — an hour matters far more against
 * the hour before it than hour 23 does against hour 22, so equal slices of the
 * curve are equal *ratios* of age. Linear would hold the mark near-full through
 * most of the day and then drop it off a cliff; this reads as a thing cooling.
 */
export function writeFreshness(
  ageSeconds: number | null,
  peak: number = WRITE_PEAK_SECONDS,
  window: number = WRITE_FRESH_WINDOW_SECONDS,
): number {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return 0;
  if (ageSeconds <= peak) return 1;
  if (ageSeconds >= window) return 0;
  return 1 - Math.log(ageSeconds / peak) / Math.log(window / peak);
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
