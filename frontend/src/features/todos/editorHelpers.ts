import { DONE_LABEL, LADDER_LABELS, buildTodoIndex, focusMatch, isSnoozed, isWaiting } from './todoHelpers';
import type { TodoItem, TodoSection } from './types';

/** One row of the full-page editor: the item, which section it lives in, and
 * its hidden-on-/todos flags. Unlike the /todos ladder, the editor SHOWS
 * snoozed/waiting items (it's the browse-everything surface) — the flags
 * become badges instead of filters. */
export interface EditorEntry {
  item: TodoItem;
  section: string;
  snoozed: boolean;
  waiting: boolean;
}

/** Every to-do across every section (ladder + Done), in section order then
 * item order — the editor's base list before filtering. */
export function flattenAllTodos(sections: TodoSection[], serverDate: string): EditorEntry[] {
  const index = buildTodoIndex(sections);
  const out: EditorEntry[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      out.push({
        item,
        section: section.name,
        snoozed: isSnoozed(item, serverDate),
        waiting: isWaiting(item, serverDate, index),
      });
    }
  }
  return out;
}

export interface EditorFilters {
  /** '' = "All" chip (the four ladder sections); DONE_LABEL = the Done chip;
   * a ladder label = just that section. */
  section: string;
  /** Case-insensitive substring match against text AND notes. */
  search: string;
  /** Focus theme key; '' = any, '__none__' = untagged (same as focusMatch). */
  theme: string;
  /** Status key; '' = any. */
  status: string;
}

export const EMPTY_EDITOR_FILTERS: EditorFilters = {
  section: '',
  search: '',
  theme: '',
  status: '',
};

function sectionMatch(entrySection: string, filter: string): boolean {
  if (filter === '') return (LADDER_LABELS as readonly string[]).includes(entrySection);
  if (filter === DONE_LABEL) return entrySection === DONE_LABEL;
  return entrySection === filter;
}

export function filterEditorTodos(entries: EditorEntry[], filters: EditorFilters): EditorEntry[] {
  const q = filters.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (!sectionMatch(e.section, filters.section)) return false;
    if (!focusMatch(e.item, filters.theme)) return false;
    if (filters.status && e.item.status !== filters.status) return false;
    if (q) {
      const haystack = `${e.item.text}\n${e.item.notes || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
