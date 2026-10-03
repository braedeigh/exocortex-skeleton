/**
 * layoutMemory.ts — where the Terrain map was, so opening it doesn't lay the
 * world out all over again.
 *
 * The map is a force simulation: every mount used to start one from scratch and
 * settle a few thousand dots into a *new* arrangement, so walking off the tab
 * and back — or reloading — cost her the map she'd learned. This module holds
 * each node's last resting position, which of them she dragged into place by
 * hand, and where the camera was pointing. terrainCanvas.ts writes it whenever
 * the map goes still or the page goes away, and reads it as the next engine
 * builds its graph (TerrainPage mounts the engine with `remember: true`; the
 * ambient backdrop doesn't, so a wallpaper map can never overwrite the real one).
 *
 * TWO LAYERS, and the second one is the point: a module-level object answers
 * every read, and it's mirrored into localStorage so the map survives a reload,
 * a closed PWA, a phone that dropped the tab. The mirror is compact on purpose
 * — one flat array per node, coordinates rounded to a tenth of a unit — because
 * a full map is a few thousand of them and this gets written on the way out of
 * the page, where a slow write is a stutter she'd feel.
 *
 * Storage may be missing or full (private mode, quota, blocked cookies). Every
 * touch of it is wrapped: the worst case is the map laying out fresh, which is
 * exactly what it did before any of this existed.
 *
 * Prompt that produced it: "i want for the map to not have to reload every time
 * i open the page ... i also want to be able to drag nodes around and for it to
 * save that position" → "when i do a hard refresh on the page it still
 * regenerates it."
 */

/** One node's resting place. `pinned` means SHE put it there by dragging — the
 * engine holds those still (d3's fx/fy) instead of letting the physics have
 * them back. */
export interface RememberedNode {
  x: number;
  y: number;
  pinned: boolean;
}

/** The d3-zoom transform, flattened — pan (x, y) and scale (k). */
export interface RememberedCamera {
  x: number;
  y: number;
  k: number;
}

export interface RememberedLayout {
  nodes: Map<string, RememberedNode>;
  camera: RememberedCamera | null;
}

/** Versioned, so a change to the stored shape — or to what the positions
 * MEAN — is ignored rather than mis-read: a bad recall would scatter the map,
 * and there's nothing here worth migrating. v3 is the folder grids
 * (fileGrids.ts) standing clear of each other: a folder is a body the size
 * of its whole grid, and positions saved before the grids could part would
 * restore with them lying on top of each other, too gently warmed to come
 * apart. */
const STORAGE_KEY = 'terrain.layout.v3';

/** Stop writing past this many characters rather than throw a quota error at
 * her on the way out of the page. ~2MB of a typical 5MB budget, which a map of
 * several thousand nodes stays well inside. */
const STORAGE_CHAR_CAP = 2_000_000;

/** One node on disk: id, x, y, pinned — positional, not named, because the key
 * names would otherwise be most of the file. */
type StoredNode = [string, number, number, 0 | 1];

interface StoredLayout {
  camera: RememberedCamera | null;
  nodes: StoredNode[];
}

/** The live answer to every read. `undefined` = storage hasn't been looked at
 * yet this page; `null` = looked, and there was nothing. */
let remembered: RememberedLayout | null | undefined = undefined;

/** A tenth of a unit is far finer than a dot is wide, and it halves the file. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Read the mirror. Anything malformed is treated as nothing at all. */
function loadStored(): RememberedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLayout;
    if (!parsed || !Array.isArray(parsed.nodes)) return null;
    const nodes = new Map<string, RememberedNode>();
    for (const entry of parsed.nodes) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const [id, x, y, pinned] = entry;
      if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      nodes.set(id, { x, y, pinned: pinned === 1 });
    }
    if (nodes.size === 0) return null;
    return { nodes, camera: parsed.camera ?? null };
  } catch {
    return null;
  }
}

/** Mirror the memory to disk. Silent on failure — see the header. */
function saveStored(layout: RememberedLayout): void {
  try {
    const stored: StoredLayout = {
      camera: layout.camera,
      nodes: [...layout.nodes].map(([id, n]): StoredNode => [id, round(n.x), round(n.y), n.pinned ? 1 : 0]),
    };
    const raw = JSON.stringify(stored);
    if (raw.length > STORAGE_CHAR_CAP) return;
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage full or unavailable: the in-memory copy still carries this page.
  }
}

/**
 * Write the map down. Nodes the sim never placed are skipped rather than
 * remembered at 0,0, which would drag them to the origin on the way back.
 */
export function rememberLayout(
  nodes: Iterable<{ id: string; x?: number; y?: number; pinned?: boolean }>,
  camera: RememberedCamera | null,
): void {
  const map = new Map<string, RememberedNode>();
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    map.set(n.id, { x: n.x as number, y: n.y as number, pinned: n.pinned === true });
  }
  remembered = { nodes: map, camera };
  saveStored(remembered);
}

/** What the last engine left behind — this page's, or the one stored by a
 * previous visit — or null if there's never been one. */
export function recallLayout(): RememberedLayout | null {
  if (remembered === undefined) remembered = loadStored();
  return remembered;
}

/** Drop the memory entirely, on disk as well: the next mount lays out fresh. */
export function forgetLayout(): void {
  remembered = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — an unreadable store is an empty one.
  }
}

/** Forget only the hand-placed ones, leaving every resting position alone —
 * what "release" does, so the physics gets those nodes back without the map
 * jumping. */
export function forgetPins(): void {
  const current = recallLayout();
  if (!current) return;
  for (const n of current.nodes.values()) n.pinned = false;
  saveStored(current);
}
