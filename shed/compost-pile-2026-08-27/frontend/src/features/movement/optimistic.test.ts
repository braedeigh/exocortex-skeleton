import { describe, expect, it } from 'vitest';
import {
  applyMoveAdd,
  applyMoveRemove,
  applyMoveReorder,
  applyMoveUpdate,
  applyRoutineAdd,
  applyRoutineRemove,
  applyRoutineUpdate,
} from './optimistic';
import type { MovementData } from './types';

function base(): MovementData {
  return {
    movement: {
      routines: [
        {
          id: 'r1',
          name: 'Morning mobility',
          note: 'slow',
          moves: [
            { id: 'm1', name: 'Neck circles', url: '', dose: '5x', note: '' },
            { id: 'm2', name: 'Cat-cow', url: 'https://youtu.be/abcdefghijk', dose: '', note: 'breathe' },
          ],
        },
        { id: 'r2', name: 'Evening stretch', moves: [] },
      ],
    },
  };
}

function names(data: MovementData, routineId: string): string[] {
  const r = data.movement?.routines?.find((x) => x.id === routineId);
  return (r?.moves ?? []).map((m) => m.id);
}

describe('routine updaters', () => {
  it('appends a new routine', () => {
    const next = applyRoutineAdd(base(), { id: 'r3', name: 'New', note: '', moves: [] });
    expect(next.movement?.routines?.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('patches only the given fields', () => {
    const next = applyRoutineUpdate(base(), 'r1', { note: 'faster' });
    const r1 = next.movement?.routines?.[0];
    expect(r1?.name).toBe('Morning mobility');
    expect(r1?.note).toBe('faster');
  });

  it('removes a routine by id', () => {
    const next = applyRoutineRemove(base(), 'r1');
    expect(next.movement?.routines?.map((r) => r.id)).toEqual(['r2']);
  });

  it('does not mutate the previous cache object', () => {
    const prev = base();
    applyRoutineRemove(prev, 'r1');
    expect(prev.movement?.routines).toHaveLength(2);
  });

  it('preserves unrelated top-level fields from /api/data/movement', () => {
    const prev = { ...base(), dev_notes: [{ id: 'n1' }] } as MovementData & { dev_notes: unknown };
    const next = applyRoutineRemove(prev, 'r2') as MovementData & { dev_notes: unknown };
    expect(next.dev_notes).toEqual([{ id: 'n1' }]);
  });
});

describe('move updaters', () => {
  it('appends a move to the right routine', () => {
    const next = applyMoveAdd(base(), 'r2', { id: 'm9', name: 'Squat', url: '', dose: '', note: '' });
    expect(names(next, 'r2')).toEqual(['m9']);
    expect(names(next, 'r1')).toEqual(['m1', 'm2']);
  });

  it('patches a single field on a move', () => {
    const next = applyMoveUpdate(base(), 'r1', 'm1', { dose: '10x' });
    const m1 = next.movement?.routines?.[0].moves?.[0];
    expect(m1?.dose).toBe('10x');
    expect(m1?.name).toBe('Neck circles');
  });

  it('removes a move by id', () => {
    expect(names(applyMoveRemove(base(), 'r1', 'm1'), 'r1')).toEqual(['m2']);
  });

  it('reorders to the given order', () => {
    expect(names(applyMoveReorder(base(), 'r1', ['m2', 'm1']), 'r1')).toEqual(['m2', 'm1']);
  });

  it('keeps moves missing from the order at the end (server semantics)', () => {
    expect(names(applyMoveReorder(base(), 'r1', ['m2']), 'r1')).toEqual(['m2', 'm1']);
  });

  it('ignores unknown ids in the order', () => {
    expect(names(applyMoveReorder(base(), 'r1', ['ghost', 'm2', 'm1']), 'r1')).toEqual(['m2', 'm1']);
  });
});
