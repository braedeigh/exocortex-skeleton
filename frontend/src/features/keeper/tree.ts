/**
 * tree.ts — pure sidebar logic ported from templates/keeper.html: group
 * labels/order, sorting (dated files newest-first), the [[wikilink]] stem
 * index, search matching, and the localStorage keys (same keys as the legacy
 * page, so open-state and last-file survive the React cutover).
 */
import type { KeeperFile } from './types';

/** Friendly group labels. Unknown groups render under their raw folder name. */
export const GROUP_LABELS: Record<string, string> = {
  Core: 'Core memory',
  people: 'People',
  Patterns: 'Patterns',
  context: 'Context',
  'tulku-diary': 'Keeper diary',
  Journal: 'Journal',
  Health: 'Health',
  meetings: 'Meetings',
  manifestation: 'Manifestation',
  practices: 'Practices',
  research: 'Research',
};

/** Display order; unknown groups fall to the end, alphabetical. */
export const GROUP_ORDER = ['Core', 'people', 'Patterns', 'context', 'tulku-diary', 'Journal', 'Health'];

/** Groups that start open when localStorage has no remembered state. */
export const DEFAULT_OPEN = new Set(['Core', 'people', 'Patterns']);

/** File names that lead with a date (journal, diary) sort newest-first. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

export interface KeeperGroup {
  group: string;
  files: KeeperFile[];
}

/** Sort one group's files: dated names newest-first, everything else alpha
 * (exact comparator from keeper.html renderTree). */
export function sortGroupFiles(files: KeeperFile[]): KeeperFile[] {
  return [...files].sort((a, b) => {
    const ad = DATE_RE.test(a.name);
    const bd = DATE_RE.test(b.name);
    if (ad && bd) return b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name);
  });
}

/** Group the flat file list into ordered, sorted sidebar groups. */
export function groupFiles(files: KeeperFile[]): KeeperGroup[] {
  const byGroup = new Map<string, KeeperFile[]>();
  for (const f of files) {
    const arr = byGroup.get(f.group);
    if (arr) arr.push(f);
    else byGroup.set(f.group, [f]);
  }
  return [...byGroup.keys()]
    .sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map((group) => ({ group, files: sortGroupFiles(byGroup.get(group) as KeeperFile[]) }));
}

/** Lowercased stem -> path for [[wikilink]] resolution; a people/ file always
 * wins a name collision. */
export function buildStemIndex(files: KeeperFile[]): Map<string, string> {
  const byStem = new Map<string, string>();
  for (const f of files) {
    const k = f.name.toLowerCase();
    if (!byStem.has(k) || f.group === 'people') byStem.set(k, f.path);
  }
  return byStem;
}

/** [[Name]] -> vault path (or undefined for a dead link). */
export function resolveStem(index: Map<string, string>, name: string): string | undefined {
  return index.get(name.trim().toLowerCase());
}

/** Search matches against "path name", lowercased — same haystack the legacy
 * rows carried in data-search. Empty query matches everything. */
export function matchesQuery(file: KeeperFile, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${file.path} ${file.name}`.toLowerCase().includes(q);
}

/** Split "people/sage.md" into { dir: "people/", base: "sage.md" } for the
 * pane-head label (dir rendered muted). */
export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** "people/sage.md" -> "sage" (undo-toast label). */
export function displayName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

// ---- localStorage (SAME keys as the legacy page — do not change) ----

export const OPEN_KEY_PREFIX = 'keeper.open.';
export const LAST_KEY = 'keeper.last';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Remembered open-state for a group; DEFAULT_OPEN when never toggled. */
export function loadGroupOpen(group: string, storage: StorageLike | null = defaultStorage()): boolean {
  const v = storage ? storage.getItem(OPEN_KEY_PREFIX + group) : null;
  return v === null ? DEFAULT_OPEN.has(group) : v === '1';
}

export function saveGroupOpen(group: string, open: boolean, storage: StorageLike | null = defaultStorage()): void {
  storage?.setItem(OPEN_KEY_PREFIX + group, open ? '1' : '0');
}

/** Last-opened file (restored on visits with no deep link). */
export function readLastPath(storage: StorageLike | null = defaultStorage()): string | null {
  return storage ? storage.getItem(LAST_KEY) : null;
}

export function writeLastPath(path: string, storage: StorageLike | null = defaultStorage()): void {
  storage?.setItem(LAST_KEY, path);
}

export function clearLastPath(storage: StorageLike | null = defaultStorage()): void {
  storage?.removeItem(LAST_KEY);
}
