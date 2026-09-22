/**
 * coilFolders.ts — any folder full of near-identical, time-stamped things,
 * wound into a spiral instead of sprayed across the map as a thicket.
 *
 * This is the general form of what the uploads archive got first. A folder
 * qualifies when its contents are MANY, ALIKE, and ORDERED BY TIME: uploads,
 * chat logs, daily journal pages, diary entries. On a map that draws a dot
 * per file, such a folder arrives as the biggest structure in its repo and
 * says nothing except "there are a lot of these", because every dot looks
 * like every other dot. Wound into a coil it says when, how often, and where
 * the quiet stretches were — and it does that in a footprint that grows with
 * the SQUARE ROOT of what it holds (spiralLayout.ts), so it stays about one
 * size no matter how long the folder gets.
 *
 * WHICH FOLDERS IS NOT DECIDED HERE. The server reads that from
 * `data/terrain_coils.json` — her file, her folders — and sends it down with
 * the payload (routes/terrain.py `_coil_listings`). Adding a coil is editing
 * that file, not editing this one.
 *
 * WHERE EACH DOT'S TIME COMES FROM is the one thing a coil can't guess, so
 * each is told, per folder:
 *
 *   'stamp' — read the moment out of the FILENAME, and throw the git history
 *     away. For a folder that git only ever bulk-moves, the history is a
 *     record of vault maintenance rather than of anything she did: measured
 *     on the uploads archive, 633 files carry 20 distinct touch-sets between
 *     them, 346 of them sharing one commit. A coil lit by that would show
 *     three flat bands meaning "a commit swept through here". The filename
 *     knows what the commit log doesn't.
 *
 *   'git' — WHEN SHE LAST EDITED IT, for a folder whose history is the only
 *     honest clock it has (pages she edits in place, notes with no date in
 *     the name). Note what this changes: a git coil's centre is "what I was
 *     last working in", where a stamp coil's centre is "most recently made".
 *     Both are true statements; they are different statements, and the
 *     strand out from a git centre walks back through ATTENTION rather than
 *     through the calendar.
 *
 *     Reading it takes more than taking the last touch. The vault's backup
 *     cron commits whatever it finds each hour, so an import or a machine
 *     migration lands as one commit across dozens of pages: measured, 95 of
 *     206 Journal/Daily pages had their newest touch set by a sweep rather
 *     than by her. The server discounts those and falls back to the commit
 *     that created a file when every touch was one — codestore.py
 *     `folder_edit_times` owns that rule — and sends the answer down with
 *     the listing, because the payload's own file list is capped and a coil
 *     folder mostly doesn't survive the cap.
 *
 * What neither source drops is `sessions`: an agent that read or wrote one of
 * these files is real attribution, and on a stamp coil it's the one thing the
 * geometry can't already tell you — a file an agent opened flares out of
 * order, deep in a cold arm.
 *
 * WHERE THE LIST COMES FROM. The server lists each folder off disk, uncapped,
 * because it has to: `repos[].files` is cut to the hottest N per repo, and
 * measured on the uploads archive that cut leaves exactly ZERO of 633. A coil
 * built from the payload's own files would have drawn empty and looked like a
 * quiet month. Scanning `repos[].files` is still the FALLBACK, for an install
 * whose server predates this, and it is honest about being second best.
 *
 * Used by TerrainPage.tsx (which owns the windows and the taps) and
 * TerrainBackdrop.tsx; pinned and drawn by terrainCanvas.ts; laid out by
 * spiralLayout.ts. Tested in coilFolders.test.ts.
 *
 * Prompt that produced it: "can you make this into a modular file that I can
 * apply to different folders? i have a few other candidates i want to assign
 * this" — generalising the uploads coil, whose own prompt was "arrange them
 * into a spiral that only shows like the last month or so ... but you could
 * click the center to load more". The two controls since: "i want like, a
 * white curve to show on the end of the spiral as if it was coming out of a
 * hole ... you can click it to 'pull' more out, instead of clicking the middle
 * file button. i want the middle file button to be something you can click to
 * hide everything but the last month maybe."
 */
import type { TerrainData, TerrainFile } from './api';

/** Where a coil's dots get their moment. See the block above — this is the
 * one thing about a folder that can't be inferred from looking at it. */
export type CoilTimeSource = 'stamp' | 'git';

/** One folder the server says to wind into a coil, with its filenames. */
export interface CoilListing {
  /** The repo it lives in. */
  repo: string;
  /** Repo-relative, with a trailing slash — `data/uploads-archive/`. */
  prefix: string;
  time: CoilTimeSource;
  /** The sizes the coil can open to — a pull on its tip widens it a step,
   * a tap on its centre collapses it to the first; `null` is everything. Per folder, because a chat log and a photo archive don't fill
   * up at remotely the same rate. */
  windows: (number | null)[];
  /** Every file in the folder, repo-relative. Uncapped. */
  paths: string[];
  /** For a 'git' coil: when each of `paths` was last edited, ALIGNED WITH IT,
   * `null` where the history knows nothing. Sent with the listing rather than
   * read off the payload's files because the payload is cut to the hottest N
   * per repo and a coil folder loses that cut badly — 7 of tulku/people's 75
   * survive it (routes/terrain.py `_coil_listings`). Absent from a 'stamp'
   * coil, whose names already carry the time, and from a server too old to
   * send it. */
  times?: (number | null)[];
}

/** How much a coil shows to begin with, when a folder names no steps of its
 * own. A month is the first step for the same reason the pond's square is a
 * month: it's the far end of the backdrop breath's swing, so a month is
 * exactly the stretch whose heat the breathing can visibly move through. */
export const DEFAULT_COIL_WINDOWS: readonly (number | null)[] = [31, 92, 183, null];

/** A window as a number you can compare: "everything" is the widest there is. */
function windowReach(days: number | null): number {
  return days === null ? Infinity : days;
}

/**
 * Every step wider than the window a coil is open to now, narrowest first —
 * the places a pull on the coil's tip can take it.
 *
 * ONE-WAY, and it can be now. A coil has two controls: the curve at its tip
 * pulls it wider, and its centre collapses it back to its first step. The
 * widening used to cycle round to the start because the centre was the only
 * control there was, and a one-way widen would have parked a 600-dot spiral on
 * the map with no way back. With the centre as the way back, the pull never
 * has to double as it.
 *
 * Compared by size rather than looked up by position, so a window that isn't
 * one of the steps (a step list she's just edited, say) still widens to the
 * next one past it.
 */
export function widerCoilWindows(
  days: number | null,
  steps: readonly (number | null)[] = DEFAULT_COIL_WINDOWS,
): (number | null)[] {
  const reach = windowReach(days);
  return [...steps]
    .filter((step) => windowReach(step) > reach)
    .sort((a, b) => windowReach(a) - windowReach(b));
}

/** A short name for a window, for the line under a coil's own name. */
export function coilWindowLabel(days: number | null): string {
  if (days === null) return 'all';
  if (days >= 365) return `${Math.round(days / 365)}y`;
  if (days >= 30) return `${Math.round(days / 30)}mo`;
  return `${days}d`;
}

/**
 * Find a date anywhere in a filename, in either of the two shapes her folders
 * actually use — `2026-02-27` and `20260326` — and the time after it if
 * there is one.
 *
 * ANYWHERE, not anchored at the front, because a real folder here puts the
 * date in the middle: the diary names its entries `00-asa-2026-02-27.md`.
 * The first date-shaped run that is a real date wins.
 *
 * Deliberately one loose parser rather than a pattern per folder. Across the
 * five candidate folders the shapes are `20260326_232944.png`,
 * `2026-07-23.101356.jsonl`, `2026-02-27.md`, `00-asa-2026-02-27.md` and
 * `20260725_IMG_2801.png` — all of them a date, optionally a six-digit time,
 * with the separators varying. A regex per folder would be five things to
 * keep right; this is one.
 */
const DATE_RUN = /(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})/g;
/** A six-digit time immediately after the date — `_232944`, `.101356`, or
 * run straight on. Never seven, or it's a longer number that happens to
 * start with a plausible time. */
const TIME_RUN = /^[._\-T ]?(\d{2})[:.]?(\d{2})[:.]?(\d{2})(?!\d)/;

/**
 * The moment in a filename, in unix seconds, or null if there isn't one.
 *
 * Parsed as LOCAL time: whatever wrote the name was standing in her timezone,
 * not in Greenwich. A file dated but not timed lands at MIDDAY — the day is
 * what's being placed, and midnight is the one hour that rounds into the
 * wrong day. Same rule routes/terrain.py `_card_epoch` uses for a card with
 * no clock on it.
 */
export function parseStampedName(name: string): number | null {
  DATE_RUN.lastIndex = 0;
  for (let m = DATE_RUN.exec(name); m !== null; m = DATE_RUN.exec(name)) {
    // Skip a run that's the tail of a longer number — `1202603` shouldn't
    // yield the year 2026. Checked here rather than with a lookbehind, which
    // older Safari on her phone wouldn't have.
    if (m.index > 0 && /\d/.test(name[m.index - 1])) continue;
    const [year, month, day] = (m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]]).map(Number);
    if (year < 1900 || year > 2999) continue;
    const after = name.slice(m.index + m[0].length);
    const timed = TIME_RUN.exec(after);
    const [hour, minute, second] = timed ? timed.slice(1, 4).map(Number) : [12, 0, 0];
    const at = new Date(year, month - 1, day, hour, minute, second);
    if (Number.isNaN(at.getTime())) continue;
    // Reject a stamp the Date constructor quietly rolled over (month 13, day
    // 32, hour 61): that's a number that isn't a date, not a date in the
    // future. Keep scanning — a later run in the name may be the real one.
    if (at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour) continue;
    return Math.floor(at.getTime() / 1000);
  }
  return null;
}

/**
 * Is this file directly inside the folder — its own child, not a grandchild?
 *
 * The coil is a statement about the folder's OWN files: the server lists only
 * those, and a nested directory arrives with its own shape and doesn't belong
 * on the strand. Membership has to be asked this way rather than with a bare
 * prefix test, because `receipts/` prefixes `receipts/grocery/photo.jpg` too —
 * and a coil that claimed that file would drop it from the map without ever
 * putting it on the spiral, taking the whole subfolder with it.
 */
function isDirectlyInside(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
}

/** The folder node a coil winds around — the trie's own id for it. */
export function coilFolderNodeId(repoId: string, prefix: string): string {
  return `${repoId}:dir:${prefix.replace(/\/$/, '')}`;
}

/** The node id the graph will give one of a coil's files. */
export function coilFileNodeId(repoId: string, path: string): string {
  return `${repoId}:file:${path}`;
}

/** One coil, resolved: what it is and how much of it is showing. */
export interface CoilView {
  prefix: string;
  repoId: string;
  /** The coil's centre — the tap that collapses it back to its first step. */
  folderId: string;
  time: CoilTimeSource;
  /** The sizes THIS coil can open to, narrowest first; `null` is everything. */
  windows: (number | null)[];
  /** The window it's open to right now. */
  windowDays: number | null;
  /** Where a pull on the tip's curve takes it: the first wider step that
   * actually brings something out. `undefined` when nothing wider would —
   * the coil is all the way out, and its curve draws straight. */
  pullTo: number | null | undefined;
  /** Where a tap on the centre takes it: its first step. */
  collapseTo: number | null;
  /** The moment of the oldest dated file on the coil, unix seconds — the far
   * end of what's showing, for the hover card. Null when none is dated. */
  oldestShownAt: number | null;
  /** Its files as node ids, NEWEST FIRST — the order spiralLayout.ts lays
   * them in, innermost first. */
  spiralIds: string[];
  /** How many it's showing, and how many exist. Its caption. */
  shown: number;
  total: number;
  hasMore: boolean;
}

export interface WindowedCoils {
  /** The payload with every coil cut to its window and re-timed. */
  data: TerrainData;
  coils: CoilView[];
}

export interface WindowCoilsOptions {
  /** How far back each coil is open, by prefix. A coil not named here opens
   * at the first of its own steps. */
  windows?: Readonly<Record<string, number | null>>;
  /** Now, in unix seconds. Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Cut every configured folder down to its window, re-time the stamped ones,
 * and say what each coil ended up holding.
 *
 * Every file in every folder that ISN'T a coil passes through untouched.
 */
export function windowCoils(
  data: TerrainData,
  options: WindowCoilsOptions = {},
): WindowedCoils {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const listings = data.coils ?? [];
  if (listings.length === 0) return { data, coils: [] };

  // Every coil file in the payload, by path — the fallback's source of
  // filenames, and on every path the source of `sessions`.
  const fromPayload = new Map<string, { repoId: string; file: TerrainFile }>();
  for (const repo of data.repos) {
    for (const file of repo.files) {
      for (const listing of listings) {
        if (isDirectlyInside(file.path, listing.prefix)) {
          fromPayload.set(file.path, { repoId: repo.id, file });
          break;
        }
      }
    }
  }

  const views: CoilView[] = [];
  /** Per repo: the coil files to drop, and the windowed ones to put back. */
  const dropPrefixes: string[] = [];
  const addByRepo = new Map<string, TerrainFile[]>();

  for (const listing of listings) {
    // Its sizes, narrowest first — so the first is what it opens and
    // collapses to, whatever order the data file lists them in.
    const windows = (listing.windows.length > 0 ? [...listing.windows] : [...DEFAULT_COIL_WINDOWS])
      .sort((x, y) => windowReach(x) - windowReach(y));
    const openTo = options.windows?.[listing.prefix];
    const windowDays = openTo === undefined ? windows[0] : openTo;

    // When a 'git' coil is in play, its times ride with the listing, aligned
    // with `paths`. Read into a map once per folder rather than per file.
    const timeByPath = new Map<string, number>();
    if (listing.times) {
      listing.paths.forEach((path, i) => {
        const at = listing.times?.[i];
        if (typeof at === 'number') timeByPath.set(path, at);
      });
    }

    // Every file in the folder with the moment the coil will order it by.
    // A file the parser can't date is set aside rather than guessed at: it
    // goes on the coil's outer TIP, past everything dated, keeping whatever
    // history it really has. It has to go on the coil SOMEWHERE, because
    // every child of the folder is pinned — one left loose would be hauled
    // at the centre by the folder rope while the coil's own body shoved it
    // out, which is exactly the strain that once had the pond tile wandering
    // the map.
    const paths = listing.paths.length > 0
      ? listing.paths
      : [...fromPayload.keys()].filter((p) => isDirectlyInside(p, listing.prefix));
    const dated: { path: string; at: number }[] = [];
    const undated: string[] = [];
    for (const path of paths) {
      const at = coilFileMoment(path, listing, fromPayload.get(path)?.file, timeByPath);
      if (at === null) undated.push(path);
      else dated.push({ path, at });
    }
    dated.sort((a, b) => b.at - a.at);

    const shownDated = datedInWindow(dated, windowDays, nowSeconds);
    // The undated only ever appear on "everything" — there's no window they
    // can honestly be said to fall inside.
    const shownUndated = windowDays === null ? undated : [];
    const shownPaths = [...shownDated.map((u) => u.path), ...shownUndated];
    // Where a pull goes: the first wider step that brings anything out. A
    // step that would add nothing (a quiet season between two busy ones) is
    // stepped over, so a pull on the curve always pays out at least one dot
    // rather than doing nothing she can see.
    const pullTo = widerCoilWindows(windowDays, windows).find(
      (step) =>
        datedInWindow(dated, step, nowSeconds).length + (step === null ? undated.length : 0) >
        shownPaths.length,
    );
    // Claimed only once it has something to show. Marking the folder for
    // removal any earlier — before this bail-out — took its files off the map
    // without putting any of them back, and the folder node the trie builds
    // from them went with it: the folder node is the coil's centre, which
    // both anchors its tip and collapses it, so a folder that came back empty
    // lost the coil's controls with it. A coil with nothing in its window is no coil; it is
    // never no folder.
    if (shownPaths.length === 0) continue;
    dropPrefixes.push(listing.prefix);

    const repoId = listing.repo || fromPayload.get(shownPaths[0])?.repoId;
    if (!repoId) continue;

    const back = addByRepo.get(repoId) ?? [];
    for (const { path, at } of shownDated) {
      const original = fromPayload.get(path)?.file;
      // A dot is LIT by the same moment it is PLACED by. The heat gradient is
      // the coil's other half — a bright core cooling down the arms is what
      // makes it read before you know what it is — so a dot ordered by one
      // clock and coloured by another would draw a spiral whose colours
      // disagree with its own shape. Both re-timings below say the same thing
      // for the same reason: what they throw away is bulk-commit noise.
      //
      // 'stamp' takes the moment out of the name. 'git' takes the edit time
      // the server worked out, which is the de-noised history — keeping the
      // payload's own touches here would put the swept commit back in as
      // heat, and for a file that never survived the payload's cut there is
      // no history to keep at all: it would draw stone cold.
      //
      // Agent attribution survives either way, because it's the one thing on
      // a re-timed coil the geometry can't already say.
      const served = listing.time !== 'git' || timeByPath.has(path);
      back.push(
        served
          ? { path, touches: [at], sessions: original?.sessions ?? [] }
          : // No served time — this is the old fallback path, reading the
            // payload's own newest touch. Its history is all there is, so it
            // is left exactly as it is.
            (original ?? { path, touches: [], sessions: [] }),
      );
    }
    // An undated file keeps its real history whatever the source: there is
    // nothing better to put there, and inventing a time is the mistake this
    // whole module exists to undo.
    for (const path of shownUndated) {
      back.push(fromPayload.get(path)?.file ?? { path, touches: [], sessions: [] });
    }
    addByRepo.set(repoId, back);

    views.push({
      prefix: listing.prefix,
      repoId,
      folderId: coilFolderNodeId(repoId, listing.prefix),
      time: listing.time,
      windows: [...windows],
      windowDays,
      pullTo,
      collapseTo: windows[0],
      oldestShownAt: shownDated.length > 0 ? shownDated[shownDated.length - 1].at : null,
      spiralIds: shownPaths.map((path) => coilFileNodeId(repoId, path)),
      shown: shownPaths.length,
      total: dated.length + undated.length,
      hasMore: shownPaths.length < dated.length + undated.length,
    });
  }

  const repos = data.repos.map((repo) => {
    const back = addByRepo.get(repo.id) ?? [];
    const kept = repo.files.filter(
      (file) => !dropPrefixes.some((p) => isDirectlyInside(file.path, p)),
    );
    if (back.length === 0 && kept.length === repo.files.length) return repo;
    return { ...repo, files: [...kept, ...back] };
  });

  return { data: { ...data, repos }, coils: views };
}

/**
 * The dated files a window lets through, newest first.
 *
 * Never empty while the folder has anything dated in it: the folder node is
 * the coil's centre AND one of its two controls, and the trie only emits a
 * folder that holds files — so an empty month would take the centre off the
 * map with it. The newest file stands in for an empty window.
 */
function datedInWindow(
  dated: readonly { path: string; at: number }[],
  windowDays: number | null,
  nowSeconds: number,
): { path: string; at: number }[] {
  const cutoff = windowDays === null ? -Infinity : nowSeconds - windowDays * 86400;
  const inside = dated.filter((u) => u.at >= cutoff);
  return inside.length === 0 && dated.length > 0 ? dated.slice(0, 1) : inside;
}

/**
 * The moment one file on a coil is ordered by — the filename for a 'stamp'
 * coil, the newest git touch for a 'git' one.
 *
 * Null means "this one has no honest time", which lands it on the coil's tip
 * rather than off the coil.
 */
function coilFileMoment(
  path: string,
  listing: CoilListing,
  file: TerrainFile | undefined,
  timeByPath: ReadonlyMap<string, number>,
): number | null {
  if (listing.time === 'git') {
    // The time the server worked out and sent uncapped — when she last really
    // edited this, with the backup cron's sweeps discounted (codestore.py
    // `folder_edit_times`). Preferred over the payload's own history because
    // most of a coil folder doesn't survive the payload's cut.
    const served = timeByPath.get(path);
    if (served !== undefined) return served;
    // Falling back to the payload's newest touch, for a server that predates
    // the served times — honest about being second best, the same way the
    // filename fallback below the listing is. Touches arrive newest-first.
    const newest = file?.touches?.[0];
    return typeof newest === 'number' ? newest : null;
  }
  const name = path.slice(listing.prefix.length);
  // Only the folder's own files, never a subfolder's — a nested directory
  // arrives with its own shape and doesn't belong on the strand.
  if (name.includes('/')) return null;
  return parseStampedName(name);
}
