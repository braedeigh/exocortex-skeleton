/**
 * undoStack.ts — pure undo/redo stacks for the scratchpad, extracted from
 * templates/notes.html (pushUndo/undoNotes/redoNotes). Same semantics, made
 * immutable so React state/refs can hold them safely:
 *
 * - A snapshot is pushed on each successful-save *attempt* with the previous
 *   saved content (autosave granularity, not per-keystroke).
 * - Pushing dedupes against the top of the undo stack and caps at MAX_UNDO
 *   (oldest dropped). A push clears the redo stack — but a *deduped* push
 *   returns early and leaves redo intact (legacy pushUndo's early return
 *   came before `redoStack = []`).
 * - undo/redo move the current text onto the opposite stack directly,
 *   without dedupe or cap (legacy undoNotes/redoNotes pushed raw).
 */

export interface UndoStacks {
  undo: readonly string[];
  redo: readonly string[];
}

export const MAX_UNDO = 20;

export const emptyStacks: UndoStacks = { undo: [], redo: [] };

/** Record `snapshot` (the previously-saved content) before a save commits. */
export function pushSnapshot(stacks: UndoStacks, snapshot: string): UndoStacks {
  if (stacks.undo.length && stacks.undo[stacks.undo.length - 1] === snapshot) {
    return stacks; // dupe: legacy returns before clearing redo
  }
  const undoNext = [...stacks.undo, snapshot];
  if (undoNext.length > MAX_UNDO) undoNext.shift();
  return { undo: undoNext, redo: [] };
}

export interface UndoResult {
  stacks: UndoStacks;
  /** The text the editor should now show (and treat as saved). */
  value: string;
}

/** Pop the last snapshot; `current` (even if unsaved) becomes redoable. */
export function undo(stacks: UndoStacks, current: string): UndoResult | null {
  if (!stacks.undo.length) return null;
  const value = stacks.undo[stacks.undo.length - 1];
  return {
    stacks: { undo: stacks.undo.slice(0, -1), redo: [...stacks.redo, current] },
    value,
  };
}

/** Re-apply the last undone text; `current` goes back onto the undo stack. */
export function redo(stacks: UndoStacks, current: string): UndoResult | null {
  if (!stacks.redo.length) return null;
  const value = stacks.redo[stacks.redo.length - 1];
  return {
    stacks: { undo: [...stacks.undo, current], redo: stacks.redo.slice(0, -1) },
    value,
  };
}

export function canUndo(stacks: UndoStacks): boolean {
  return stacks.undo.length > 0;
}

export function canRedo(stacks: UndoStacks): boolean {
  return stacks.redo.length > 0;
}
