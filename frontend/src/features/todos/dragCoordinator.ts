/**
 * dragCoordinator.ts — lets a pointer-drag started in one <TodoSection>
 * report hover/drop state into whichever *other* section it's currently
 * over, so a to-do can be dragged straight from "Now" into "Later" (etc.)
 * without going through the detail sheet's "Move to" picker.
 *
 * Each mounted TodoSection registers a handle (getters read live refs, so
 * registration only needs to happen once per section). The handle exposing
 * `getItems`/`getRowEls` lets any *other* section's drag compute an insertion
 * index against this section's current rows; `setOverId`/`setHovered` let the
 * coordinator drive this section's own highlight state as the pointer moves
 * over it, even though the drag started elsewhere.
 *
 * This is plain module state (not React state / context) on purpose — a
 * pointermove fires far too often to route through a shared context provider
 * without extra re-render plumbing, and drag lifetime is strictly bounded to
 * one pointer gesture, so there's no risk of stale global state outliving it.
 */
import type { TodoItem } from './types';

export interface SectionDragHandle {
  label: string;
  getItems: () => TodoItem[];
  getContainerEl: () => HTMLElement | null;
  getRowEls: () => Map<string, HTMLElement>;
  /** Row-level highlight — id of the row this drag would land before, or null for "end of list". */
  setOverId: (id: string | null) => void;
  /** Card-level highlight — true while this section is the current drop target (even if it has no rows to line up against). */
  setHovered: (hovered: boolean) => void;
}

export interface DragResult {
  id: string;
  originLabel: string;
  overLabel: string | null;
  overId: string | null;
}

const registry = new Map<string, SectionDragHandle>();
let active: DragResult | null = null;

export function registerSectionDrag(handle: SectionDragHandle): () => void {
  registry.set(handle.label, handle);
  return () => {
    if (registry.get(handle.label) === handle) registry.delete(handle.label);
  };
}

function sectionAtPoint(x: number, y: number): SectionDragHandle | null {
  for (const handle of registry.values()) {
    const el = handle.getContainerEl();
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return handle;
  }
  return null;
}

function rowIdAt(handle: SectionDragHandle, clientY: number): string | null {
  let lastId: string | null = null;
  for (const it of handle.getItems()) {
    const el = handle.getRowEls().get(it.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return it.id;
    lastId = it.id;
  }
  return lastId;
}

export function beginDrag(id: string, originLabel: string) {
  active = { id, originLabel, overLabel: originLabel, overId: null };
}

export function updateDrag(clientX: number, clientY: number) {
  if (!active) return;
  const hovered = sectionAtPoint(clientX, clientY);
  const overId = hovered ? rowIdAt(hovered, clientY) : null;
  active.overLabel = hovered ? hovered.label : null;
  active.overId = overId;
  for (const handle of registry.values()) {
    const isHovered = handle === hovered;
    handle.setHovered(isHovered);
    handle.setOverId(isHovered ? overId : null);
  }
}

/** Ends the drag, clears all sections' highlight state, and returns the final drop target (or null if none was active). */
export function endDrag(): DragResult | null {
  const result = active;
  active = null;
  for (const handle of registry.values()) {
    handle.setHovered(false);
    handle.setOverId(null);
  }
  return result;
}

export function getSectionItemIds(label: string): string[] {
  return (registry.get(label)?.getItems() ?? []).map((it) => it.id);
}
