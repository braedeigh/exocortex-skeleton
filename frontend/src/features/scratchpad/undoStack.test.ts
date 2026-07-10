import { describe, expect, it } from 'vitest';
import { MAX_UNDO, canRedo, canUndo, emptyStacks, pushSnapshot, redo, undo } from './undoStack';

describe('pushSnapshot', () => {
  it('pushes a snapshot and clears the redo stack', () => {
    const withRedo = { undo: ['a'], redo: ['z'] };
    expect(pushSnapshot(withRedo, 'b')).toEqual({ undo: ['a', 'b'], redo: [] });
  });

  it('skips a snapshot equal to the top of the undo stack and keeps redo intact', () => {
    // Legacy pushUndo returned early on a dupe *before* clearing redoStack —
    // a failed save retried with the same lastSaved must not eat the redo.
    const state = { undo: ['a'], redo: ['z'] };
    expect(pushSnapshot(state, 'a')).toEqual({ undo: ['a'], redo: ['z'] });
  });

  it('caps the undo stack at MAX_UNDO by dropping the oldest snapshot', () => {
    let state = emptyStacks;
    for (let i = 0; i < MAX_UNDO + 5; i++) {
      state = pushSnapshot(state, `v${i}`);
    }
    expect(state.undo).toHaveLength(MAX_UNDO);
    expect(state.undo[0]).toBe('v5');
    expect(state.undo[state.undo.length - 1]).toBe(`v${MAX_UNDO + 4}`);
  });

  it('does not mutate the input stacks', () => {
    const state = { undo: ['a'], redo: ['z'] };
    pushSnapshot(state, 'b');
    expect(state).toEqual({ undo: ['a'], redo: ['z'] });
  });
});

describe('undo', () => {
  it('returns null when there is nothing to undo', () => {
    expect(undo(emptyStacks, 'current')).toBeNull();
  });

  it('restores the last snapshot and moves the current text to redo', () => {
    const state = pushSnapshot(pushSnapshot(emptyStacks, 'v1'), 'v2');
    const result = undo(state, 'current');
    expect(result).toEqual({ stacks: { undo: ['v1'], redo: ['current'] }, value: 'v2' });
  });

  it('keeps unsaved keystrokes recoverable — the live text goes to redo even if it was never saved', () => {
    const state = pushSnapshot(emptyStacks, 'saved');
    const result = undo(state, 'saved plus unsaved typing');
    expect(result?.value).toBe('saved');
    expect(result?.stacks.redo).toEqual(['saved plus unsaved typing']);
  });
});

describe('redo', () => {
  it('returns null when there is nothing to redo', () => {
    expect(redo(emptyStacks, 'current')).toBeNull();
  });

  it('restores the redone text and moves the current text back to undo', () => {
    const afterUndo = undo(pushSnapshot(emptyStacks, 'v1'), 'v2');
    const result = redo(afterUndo!.stacks, afterUndo!.value);
    expect(result).toEqual({ stacks: { undo: ['v1'], redo: [] }, value: 'v2' });
  });

  it('round-trips undo then redo back to the original text', () => {
    let state = emptyStacks;
    state = pushSnapshot(state, 'one');
    state = pushSnapshot(state, 'two');
    const u = undo(state, 'three');
    const r = redo(u!.stacks, u!.value);
    expect(r?.value).toBe('three');
    expect(r?.stacks.undo).toEqual(['one', 'two']);
  });
});

describe('canUndo / canRedo', () => {
  it('reflects stack emptiness', () => {
    expect(canUndo(emptyStacks)).toBe(false);
    expect(canRedo(emptyStacks)).toBe(false);
    const pushed = pushSnapshot(emptyStacks, 'a');
    expect(canUndo(pushed)).toBe(true);
    const undone = undo(pushed, 'b');
    expect(canRedo(undone!.stacks)).toBe(true);
  });
});
