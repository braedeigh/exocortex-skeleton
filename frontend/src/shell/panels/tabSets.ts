import { SECTIONS, sectionById, type Section } from './sections';

/**
 * tabSets.ts — the sets of pinned tabs, as data.
 *
 * A set is a name and an ordered list of section ids. A panel wears one. Two
 * panels — usually two windows on two monitors — can wear different ones, which
 * is the whole point: the screen where sessions run doesn't want the same tabs
 * as the screen where the journal lives.
 *
 * Everything here is a pure function over the list of sets: create, remove,
 * pin, unpin, reorder. Each returns the SAME array when nothing changed, so a
 * no-op can't trigger a save or a re-render. That's also what lets the whole
 * model be checked without rendering anything (tabSets.test.ts) — and it
 * matters more than usual here, because these are saved to the vault and a bad
 * write is a bar with no tabs in it.
 *
 * New ids are passed IN rather than minted here, the same way layoutTree.ts
 * does it: a function that invents its own random id can't be checked against
 * an expected result. TabBar.tsx mints them.
 *
 * Unknown section ids are SKIPPED rather than treated as an error. The server
 * stores ids without interpreting them (routes/tabsets.py), so a set saved
 * when a section existed, and loaded after it was renamed, should cost her that
 * one tab — not the whole bar.
 *
 * Touches: sections.ts (what an id means), useTabSets.ts (loads and saves),
 * TabBar.tsx (draws a set).
 */

export interface TabSet {
  id: string;
  name: string;
  sections: string[];
}

/** Matches routes/tabsets.py's DEFAULT — used before the server answers, so
 *  the bar isn't empty for the first moment of every page load. */
export const DEFAULT_SETS: TabSet[] = [
  // Just the Observatory: this is the set for the panel that watches
  // sessions, and the live ones fill the rest of its bar on their own.
  { id: 'work', name: 'Work', sections: ['observatory'] },
  { id: 'life', name: 'Life', sections: ['journal', 'dashboard', 'pond'] },
  // Deliberately empty: a bar for whatever she's doing this week, that doesn't
  // cost her either of the other two to set up.
  { id: 'spare', name: 'Spare', sections: [] },
];

/* ---------- making and unmaking sets ---------- */

/** A new, empty set on the end. Empty rather than a copy of anything: the bar
 *  then says "nothing pinned — use the ▾", which is already the next
 *  instruction. A duplicate or blank id is refused, since two sets answering to
 *  one id would make every operation below ambiguous. */
export function createSet(sets: TabSet[], id: string, name: string): TabSet[] {
  if (!id || sets.some((s) => s.id === id)) return sets;
  return [...sets, { id, name, sections: [] }];
}

/** Delete a set — except the last one. A workspace with no sets is a workspace
 *  where no panel has a bar, and there'd be no ▾ left to make one from, so the
 *  floor is here as well as on the server (routes/tabsets.py refuses a PUT that
 *  leaves nothing). */
export function removeSet(sets: TabSet[], setId: string): TabSet[] {
  if (sets.length <= 1) return sets;
  const next = sets.filter((s) => s.id !== setId);
  return next.length === sets.length ? sets : next;
}

/**
 * Which built-in sets are deleted, for the server to write down.
 *
 * There's no separate bookkeeping for this: a built-in missing from the list
 * the server just sent us IS the deletion, because the server seeds back every
 * built-in it hasn't been told about. So the answer is always derivable from
 * what's in front of us, and there's no second copy to drift.
 */
export function removedBuiltIns(sets: TabSet[]): string[] {
  return DEFAULT_SETS.filter((d) => !sets.some((s) => s.id === d.id)).map((d) => d.id);
}

/** The sections a set actually shows, with any ids that no longer exist
 *  quietly dropped (see the header). */
export function sectionsOf(sets: TabSet[], setId: string): Section[] {
  const set = sets.find((s) => s.id === setId);
  if (!set) return [];
  return set.sections.map(sectionById).filter((s): s is Section => Boolean(s));
}

export function isPinned(sets: TabSet[], setId: string, sectionId: string): boolean {
  return sets.find((s) => s.id === setId)?.sections.includes(sectionId) ?? false;
}

function mapSet(sets: TabSet[], setId: string, fn: (set: TabSet) => TabSet): TabSet[] {
  let changed = false;
  const next = sets.map((s) => {
    if (s.id !== setId) return s;
    const updated = fn(s);
    if (updated !== s) changed = true;
    return updated;
  });
  return changed ? next : sets;
}

/** Add a section to the end of a set. Already there = nothing happens, so the
 *  star in the menu is a straightforward toggle. */
export function pin(sets: TabSet[], setId: string, sectionId: string): TabSet[] {
  if (!sectionById(sectionId)) return sets;
  return mapSet(sets, setId, (set) =>
    set.sections.includes(sectionId) ? set : { ...set, sections: [...set.sections, sectionId] },
  );
}

export function unpin(sets: TabSet[], setId: string, sectionId: string): TabSet[] {
  return mapSet(sets, setId, (set) =>
    set.sections.includes(sectionId)
      ? { ...set, sections: set.sections.filter((x) => x !== sectionId) }
      : set,
  );
}

/** Drag one tab to another position. Out-of-range indexes are ignored rather
 *  than clamped — a drop that landed nowhere should leave the bar alone, not
 *  silently move the tab somewhere she didn't aim at. */
export function reorder(sets: TabSet[], setId: string, from: number, to: number): TabSet[] {
  return mapSet(sets, setId, (set) => {
    const n = set.sections.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return set;
    const sections = [...set.sections];
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    return { ...set, sections };
  });
}

/** Everything not already in this set, for the "go / pin" half of the menu.
 *  Pinned sections still appear — the menu is also how you get somewhere, and
 *  a destination vanishing from the list because you pinned it would be worse
 *  than a slightly longer list. */
export function menuSections(): Section[] {
  return SECTIONS;
}

/** Trust check for what came back from the server. A set list that fails this
 *  is replaced by the defaults rather than leaving her with no tabs. */
export function isTabSetList(value: unknown): value is TabSet[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as TabSet).id === 'string' &&
        typeof (s as TabSet).name === 'string' &&
        Array.isArray((s as TabSet).sections) &&
        (s as TabSet).sections.every((x) => typeof x === 'string'),
    )
  );
}
