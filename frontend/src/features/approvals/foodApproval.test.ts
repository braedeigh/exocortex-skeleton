import { describe, expect, it } from 'vitest';
import { buildFoodSet, foodDraftFromPayload, prevFoodNotes } from './foodApproval';
import type { HealthDay } from '../todos/types';

describe('foodDraftFromPayload', () => {
  it('prefills date and notes from the staged payload', () => {
    expect(foodDraftFromPayload({ date: '2026-07-09', food_notes: 'rice; broth' })).toEqual({
      date: '2026-07-09',
      foodNotes: 'rice; broth',
    });
  });

  it('leaves fields blank when the payload is missing them', () => {
    expect(foodDraftFromPayload({})).toEqual({ date: '', foodNotes: '' });
  });
});

describe('buildFoodSet', () => {
  it('requires a date (legacy focused the date input)', () => {
    expect(buildFoodSet({ date: '  ', foodNotes: 'rice' }).ok).toBe(false);
  });

  it('builds the exact /api/food/set body, trimmed', () => {
    expect(buildFoodSet({ date: ' 2026-07-09 ', foodNotes: ' rice; broth ' })).toEqual({
      ok: true,
      value: { date: '2026-07-09', food_notes: 'rice; broth' },
    });
  });

  it('allows empty notes — that clears the day', () => {
    const r = buildFoodSet({ date: '2026-07-09', foodNotes: '' });
    expect(r.ok && r.value.food_notes).toBe('');
  });
});

describe('prevFoodNotes', () => {
  const rows: HealthDay[] = [
    { date: '2026-07-08', food_notes: 'oats; tea' },
    { date: '2026-07-09' },
  ];

  it('captures the previous notes for a real undo', () => {
    expect(prevFoodNotes(rows, '2026-07-08')).toBe('oats; tea');
  });

  it('is empty when the day had no notes / no row / no data (undo then clears)', () => {
    expect(prevFoodNotes(rows, '2026-07-09')).toBe('');
    expect(prevFoodNotes(rows, '2026-01-01')).toBe('');
    expect(prevFoodNotes(undefined, '2026-07-08')).toBe('');
  });
});
