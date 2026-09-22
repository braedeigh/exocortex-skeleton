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
 *   'git' — keep the real touches, for a folder whose history IS honest
 *     (pages she edits in place, notes with no date in the name). Note what
 *     this changes: a git coil is ordered by LAST TOUCH, so its centre is
 *     "most recently tended", where a stamp coil's centre is "most recently
 *     made". Both are true statements; they are different statements.
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
 * click the center to load more".
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
  /** The window steps a tap on the centre walks through; `null` is
   * everything. Per folder, because a chat log and a photo archive don't fill
   * up at remotely the same rate. */
  windows: (number | null)[];
  /** Every file in the folder, repo-relative. Uncapped. */
  paths: string[];
}

/** How much a coil shows to begin with, when a folder names no steps of its
 * own. A month is the first step for the same reason the pond's square is a
 * month: it's the far end of the backdrop breath's swing, so a month is
 * exactly the stretch whose heat the breathing can visibly move through. */
export const DEFAULT_COIL_WINDOWS: readonly (number | null)[] = [31, 92, 183, null];

/**
 * The next window a tap on a coil's centre opens — and, from the last step,
 * back to the first.
 *
 * It cycles rather than stopping at "everything" because the centre is the
 * only control a coil has: a one-way widen would leave a 600-dot spiral
 * parked on the map with no way back short of a reload.
 */
export function nextCoilWindow(
  days: number | null,
  steps: readonly (number | null)[] = DEFAULT_COIL_WINDOWS,
): number | null {
  if (steps.length === 0) return null;
  const at = steps.indexOf(days);
  if (at < 0) return steps[0];
  return steps[(at + 1) % steps.length];
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
  /** The coil's centre, and the only thing on it she can tap. */
  folderId: string;
  time: CoilTimeSource;
  /** The steps THIS coil's centre walks through. */
  windows: (number | null)[];
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
        if (file.path.startsWith(listing.prefix)) {
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
    const windows = listing.windows.length > 0 ? listing.windows : [...DEFAULT_COIL_WINDOWS];
    const openTo = options.windows?.[listing.prefix];
    const windowDays = openTo === undefined ? windows[0] : openTo;
    dropPrefixes.push(listing.prefix);

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
      : [...fromPayload.keys()].filter((p) => p.startsWith(listing.prefix));
    const dated: { path: string; at: number }[] = [];
    const undated: string[] = [];
    for (const path of paths) {
      const at = coilFileMoment(path, listing, fromPayload.get(path)?.file);
      if (at === null) undated.push(path);
      else dated.push({ path, at });
    }
    dated.sort((a, b) => b.at - a.at);

    // The window. It is never allowed to come back empty while the folder
    // has anything in it: the folder node is the coil's centre AND its only
    // control, and the trie only emits a folder that holds files — so an
    // empty month would take the "load more" target off the map with it.
    const cutoff = windowDays === null ? -Infinity : nowSeconds - windowDays * 86400;
    let shownDated = dated.filter((u) => u.at >= cutoff);
    if (shownDated.length === 0 && dated.length > 0) shownDated = dated.slice(0, 1);
    // The undated only ever appear on "everything" — there's no window they
    // can honestly be said to fall inside.
    const shownUndated = windowDays === null ? undated : [];
    const shownPaths = [...shownDated.map((u) => u.path), ...shownUndated];
    if (shownPaths.length === 0) continue;

    const repoId = listing.repo || fromPayload.get(shownPaths[0])?.repoId;
    if (!repoId) continue;

    const back = addByRepo.get(repoId) ?? [];
    for (const { path, at } of shownDated) {
      const original = fromPayload.get(path)?.file;
      back.push(
        listing.time === 'git'
          ? // An honest history is left exactly as it is.
            (original ?? { path, touches: [], sessions: [] })
          : {
              path,
              // The one honest touch: the moment in the name. The git
              // history this replaces is bulk-commit noise — see the top.
              touches: [at],
              // Agent attribution survives, because it's the only thing on a
              // stamp coil that the coil's own shape can't say.
              sessions: original?.sessions ?? [],
            },
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
      spiralIds: shownPaths.map((path) => coilFileNodeId(repoId, path)),
      shown: shownPaths.length,
      total: dated.length + undated.length,
      hasMore: shownPaths.length < dated.length + undated.length,
    });
  }

  const repos = data.repos.map((repo) => {
    const back = addByRepo.get(repo.id) ?? [];
    const kept = repo.files.filter((file) => !dropPrefixes.some((p) => file.path.startsWith(p)));
    if (back.length === 0 && kept.length === repo.files.length) return repo;
    return { ...repo, files: [...kept, ...back] };
  });

  return { data: { ...data, repos }, coils: views };
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
): number | null {
  if (listing.time === 'git') {
    // Touches arrive newest-first, which the payload guarantees.
    const newest = file?.touches?.[0];
    return typeof newest === 'number' ? newest : null;
  }
  const name = path.slice(listing.prefix.length);
  // Only the folder's own files, never a subfolder's — a nested directory
  // arrives with its own shape and doesn't belong on the strand.
  if (name.includes('/')) return null;
  return parseStampedName(name);
}
