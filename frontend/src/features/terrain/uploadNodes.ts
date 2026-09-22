/**
 * uploadNodes.ts — the uploads folder, cut down to a window and re-timed, so
 * the map can draw it as a coil instead of a thicket.
 *
 * THE PROBLEM THIS SOLVES, TWICE OVER.
 *
 * First, the size. The uploads folder is one file per thing she's ever
 * dropped into the vault — 676 of them on this install, mostly screenshots —
 * and on a map that draws a dot per file they arrive as the biggest branch in
 * the vault, a spray of identical dots that says nothing except "there are a
 * lot". Same complaint the journal had before pondNodes.ts collapsed it. The
 * answer here is different, though, because she wants to keep the dots: only
 * the last month or so reaches the graph, and terrainCanvas.ts pins that month
 * into a spiral around the folder node (spiralLayout.ts). Tapping the middle
 * widens the window a step — a month, a season, half a year, everything — and
 * the coil grows by the square root of what it holds, so it never explodes.
 *
 * Second, and worse: THE TIMES ARE WRONG. An upload's git history is a record
 * of when the VAULT was reorganised, not of when she uploaded anything.
 * Measured on this install: 633 uploads carry just 20 distinct touch-sets
 * between them — 346 share one bulk-commit stamp, another 221 share the
 * stamp of the day the vault moved machines. Left alone, the coil would light
 * up in three flat bands, each meaning "a maintenance commit swept through
 * here", and the heat map — the thing she asked to keep working — would be
 * confidently, uselessly wrong.
 *
 * So the git touches are DROPPED and replaced with one honest touch: the
 * moment in the filename. `20260326_232944.png` is the upload, to the second,
 * written by whatever saved it. That's the same move pondNodes.ts makes for
 * card files, and for the same reason — the filename knows something the
 * commit log doesn't.
 *
 * What is NOT dropped is `sessions`: an agent that read or wrote a photo is
 * real attribution, and it's the one thing on the coil the geometry can't
 * already tell you. A photo an agent opened keeps its ring and flares out of
 * order, deep in a cold arm.
 *
 * WHERE THE LIST COMES FROM. `data.uploads` — the folder listed straight off
 * disk by routes/terrain.py, uncapped. It has to be: `repos[].files` is cut
 * to the hottest N per repo, and measured here that cut leaves exactly ZERO
 * uploads out of 633, because their fake bulk-commit timestamps rank them
 * below almost everything. A coil built from the payload's own files would
 * have drawn empty and looked like a feature. Scanning `repos[].files` is
 * still the FALLBACK, for an install whose server predates this, and it is
 * honest about being second best.
 *
 * Used by TerrainPage.tsx (which owns the window and the tap) and
 * TerrainBackdrop.tsx; pinned by terrainCanvas.ts. Tested in
 * uploadNodes.test.ts.
 *
 * Prompt that produced it: "there's a few blobs of dots that are like photo
 * uploads and stuff ... arrange them into a spiral that only shows like the
 * last month or so of uploads and work with the same heat map as other dots,
 * but you could click the center to load more".
 */
import type { TerrainData, TerrainFile } from './api';

/** The uploads folder, repo-relative. Everything under it is coil. */
export const UPLOADS_PREFIX = 'data/uploads-archive/';

/**
 * How much the coil shows, in days, each tap of the centre moving one step
 * along. `null` is everything ever.
 *
 * A month is the first step for the same reason the pond's square is a month:
 * it's the far end of the backdrop breath's swing, so a month of uploads is
 * exactly the stretch whose heat the breathing can visibly move through.
 */
export const UPLOAD_WINDOW_STEPS: readonly (number | null)[] = [31, 92, 183, null];

/** Where the coil starts, and what it returns to. */
export const UPLOAD_WINDOW_DAYS = UPLOAD_WINDOW_STEPS[0];

/**
 * The next window a tap on the centre opens — and, from the last step, back
 * to the first.
 *
 * It cycles rather than stopping at "everything" because the centre is the
 * only control the coil has: a one-way widen would leave a 600-dot spiral
 * parked on the map with no way back short of a reload.
 */
export function nextUploadWindow(days: number | null): number | null {
  const at = UPLOAD_WINDOW_STEPS.indexOf(days);
  if (at < 0) return UPLOAD_WINDOW_STEPS[0];
  return UPLOAD_WINDOW_STEPS[(at + 1) % UPLOAD_WINDOW_STEPS.length];
}

/** A short name for the window, for the label under the coil. */
export function uploadWindowLabel(days: number | null): string {
  if (days === null) return 'all';
  if (days >= 365) return `${Math.round(days / 365)}y`;
  if (days >= 30) return `${Math.round(days / 30)}mo`;
  return `${days}d`;
}

/**
 * When an upload happened, read off its filename — `20260326_232944.png` →
 * that moment, in unix seconds. Returns null for anything that isn't an
 * upload or isn't stamped, so a stray file in the folder keeps its real
 * history rather than being handed a guess.
 *
 * Parsed as LOCAL time: whatever wrote the name was standing in her timezone,
 * not in Greenwich.
 */
const UPLOAD_STAMP_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;
/** The other form the archive holds: a date, then whatever the camera or the
 * browser called it — `20260725_IMG_2801.png`. Dated but not timed. */
const UPLOAD_DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:[_.\-]|$)/;

export function parseUploadPath(path: string, prefix: string = UPLOADS_PREFIX): number | null {
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  // Only the folder's own files, never a subfolder's — a nested directory
  // would arrive with its own shape and doesn't belong on the strand.
  if (name.includes('/')) return null;
  const stamped = UPLOAD_STAMP_RE.exec(name);
  const dated = stamped ?? UPLOAD_DATE_RE.exec(name);
  if (!dated) return null;
  const [year, month, day] = dated.slice(1, 4).map(Number);
  // An upload dated but not timed lands at MIDDAY, not midnight — the day is
  // what's being placed, and midnight is the one hour that rounds into the
  // wrong one. Same rule routes/terrain.py `_card_epoch` uses for a card with
  // no clock on it.
  const [hour, minute, second] = stamped ? stamped.slice(4, 7).map(Number) : [12, 0, 0];
  const at = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(at.getTime())) return null;
  // Reject a stamp the Date constructor quietly rolled over (month 13, day
  // 32): that's a filename that isn't a date, not a date in the future.
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return Math.floor(at.getTime() / 1000);
}

/** The folder node the coil winds around — the trie's own id for it. */
export function uploadsFolderNodeId(repoId: string, prefix: string = UPLOADS_PREFIX): string {
  return `${repoId}:dir:${prefix.replace(/\/$/, '')}`;
}

/** The node id the graph will give one upload. */
export function uploadNodeId(repoId: string, path: string): string {
  return `${repoId}:file:${path}`;
}

export interface WindowedUploads {
  /** The payload with the coil's window in place of the whole folder. */
  data: TerrainData;
  /** The repo the uploads live in, or null if this install has none. */
  repoId: string | null;
  /** The folder node the coil winds around — its centre, and the only thing
   * on it she can tap to widen the window. Null when there's no coil. */
  folderId: string | null;
  /** The coil's dots as node ids, NEWEST FIRST — which is the order
   * spiralLayout.ts lays them in, innermost first. */
  spiralIds: string[];
  /** How many the coil is showing, and how many exist. The centre's label. */
  shown: number;
  total: number;
  /** Is there anything older left to open? */
  hasMore: boolean;
}

export interface WindowUploadsOptions {
  /** How far back to show; null for everything. */
  windowDays?: number | null;
  /** Now, in unix seconds. Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Cut the uploads folder down to its window, and re-time what's left.
 *
 * Every other file in every repo passes through untouched.
 */
export function windowUploads(
  data: TerrainData,
  options: WindowUploadsOptions = {},
): WindowedUploads {
  const windowDays = options.windowDays === undefined ? UPLOAD_WINDOW_DAYS : options.windowDays;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Where the folder lives is the SERVER's to say — it resolves
  // store.UPLOAD_ARCHIVE_DIR, which an install can move with an env var. The
  // constant here is only what to look under when no server said.
  const prefix = data.uploads?.prefix ?? UPLOADS_PREFIX;

  // The list off disk wins when the server sent one; counting the payload's
  // own files is the fallback, and on a capped payload it finds almost none.
  const listed = data.uploads?.paths ?? null;
  const fromPayload = new Map<string, TerrainFile>();
  let foundRepoId: string | null = null;
  for (const repo of data.repos) {
    for (const file of repo.files) {
      if (!file.path.startsWith(prefix)) continue;
      fromPayload.set(file.path, file);
      foundRepoId ??= repo.id;
    }
  }
  const repoId = data.uploads?.repo ?? foundRepoId;
  if (repoId === null) {
    return {
      data,
      repoId: null,
      folderId: null,
      spiralIds: [],
      shown: 0,
      total: 0,
      hasMore: false,
    };
  }

  // Every upload known, newest first — the strand read from the centre out.
  // An unstamped file is set aside rather than guessed at: it goes on the
  // coil's outer TIP, past every dated upload, keeping whatever history it
  // really has. It has to go on the coil somewhere, because every child of
  // this folder is pinned — one left loose would be hauled at the centre by
  // the folder rope while the coil's own body shoved it out, which is exactly
  // the strain that once had the pond tile wandering the map.
  const paths = listed ?? [...fromPayload.keys()];
  const dated: { path: string; at: number }[] = [];
  const undated: string[] = [];
  for (const path of paths) {
    const at = parseUploadPath(path, prefix);
    if (at === null) undated.push(path);
    else dated.push({ path, at });
  }
  dated.sort((a, b) => b.at - a.at);

  // The window. It is never allowed to come back empty while uploads exist:
  // the folder node is the coil's centre AND its only control, and the trie
  // only emits a folder that holds files — so an empty month would take the
  // "load more" target off the map with it.
  const cutoff = windowDays === null ? -Infinity : nowSeconds - windowDays * 86400;
  let shownDated = dated.filter((u) => u.at >= cutoff);
  if (shownDated.length === 0 && dated.length > 0) shownDated = dated.slice(0, 1);
  // The undated only ever appear on "everything" — there's no window they can
  // honestly be said to fall inside.
  const shownUndated = windowDays === null ? undated : [];

  const shownPaths = [...shownDated.map((u) => u.path), ...shownUndated];
  const spiralIds = shownPaths.map((path) => uploadNodeId(repoId, path));
  const onCoil = new Set(shownPaths);

  const repos = data.repos.map((repo) => {
    if (repo.id !== repoId) return repo;
    const kept = repo.files.filter((file) => !file.path.startsWith(prefix));
    for (const upload of shownDated) {
      const original = fromPayload.get(upload.path);
      kept.push({
        path: upload.path,
        // The one honest touch: when she uploaded it. The git history this
        // replaces is bulk-commit noise — see the block at the top.
        touches: [upload.at],
        // Agent attribution survives, because it's the only thing on the coil
        // that the coil's own shape can't say.
        sessions: original?.sessions ?? [],
      });
    }
    // An undated upload keeps its real history untouched: there is nothing
    // better to put there, and inventing a time is the mistake this whole
    // module exists to undo.
    for (const path of shownUndated) {
      kept.push(fromPayload.get(path) ?? { path, touches: [], sessions: [] });
    }
    return { ...repo, files: kept };
  });

  return {
    data: { ...data, repos },
    repoId,
    folderId: uploadsFolderNodeId(repoId, prefix),
    spiralIds,
    shown: onCoil.size,
    total: dated.length + undated.length,
    hasMore: onCoil.size < dated.length + undated.length,
  };
}
