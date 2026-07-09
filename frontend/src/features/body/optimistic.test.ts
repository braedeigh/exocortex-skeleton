import { describe, expect, it } from 'vitest';
import { applyFoodAppend, applyFoodNotes, applySafetyTag, applySymptoms } from './optimistic';
import type { BodyData } from './types';

const base: BodyData = {
  server_date: '2026-07-09',
  health_data: [
    { date: '2026-07-08', date_short: 'Jul 08', energy: 2, food_notes: 'rice' },
    { date: '2026-07-09', date_short: 'Jul 09', energy: null, food_notes: null },
  ],
  kitchen_safety_tags: { kale: 'safe' },
};

describe('applySymptoms', () => {
  it('writes numeric levels onto the day and casts nose_spray to boolean', () => {
    const next = applySymptoms(base, '2026-07-09', { energy: 1, headache: 2, nose_spray: 1 });
    const day = next.health_data?.find((d) => d.date === '2026-07-09');
    expect(day).toMatchObject({ energy: 1, headache: 2, nose_spray: true });
    // untouched day survives, input not mutated
    expect(next.health_data?.[0].energy).toBe(2);
    expect(base.health_data?.[1].energy).toBeNull();
  });
  it('inserts a sorted row for a date with no data yet', () => {
    const next = applySymptoms(base, '2026-07-07', { energy: 3, nose_spray: 0 });
    expect(next.health_data?.map((d) => d.date)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09']);
    expect(next.health_data?.[0]).toMatchObject({ energy: 3, nose_spray: false, date_short: 'Jul 07' });
  });
});

describe('applyFoodNotes / applyFoodAppend', () => {
  it('replaces notes; empty string clears to null', () => {
    expect(applyFoodNotes(base, '2026-07-08', 'kale; oats').health_data?.[0].food_notes).toBe('kale; oats');
    expect(applyFoodNotes(base, '2026-07-08', '').health_data?.[0].food_notes).toBeNull();
  });
  it('appends with a ; separator, or starts the list when empty', () => {
    expect(applyFoodAppend(base, '2026-07-08', 'kale').health_data?.[0].food_notes).toBe('rice; kale');
    expect(applyFoodAppend(base, '2026-07-09', 'kale').health_data?.[1].food_notes).toBe('kale');
  });
});

describe('applySafetyTag', () => {
  it('sets lowercase keys and clears on empty tag', () => {
    const tagged = applySafetyTag(base, 'Beans', 'suspect');
    expect(tagged.kitchen_safety_tags).toEqual({ kale: 'safe', beans: 'suspect' });
    const cleared = applySafetyTag(tagged, 'KALE', '');
    expect(cleared.kitchen_safety_tags).toEqual({ beans: 'suspect' });
    expect(base.kitchen_safety_tags).toEqual({ kale: 'safe' });
  });
});
