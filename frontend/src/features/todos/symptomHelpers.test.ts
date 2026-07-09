import { describe, expect, it } from 'vitest';
import { symptomTip, symptomsLoggedOn } from './symptomHelpers';
import type { HealthDay } from './types';

const TODAY = '2026-07-08';

describe('symptomsLoggedOn', () => {
  it('is logged when the day has an energy value', () => {
    const rows: HealthDay[] = [{ date: TODAY, energy: 2 }];
    expect(symptomsLoggedOn(rows, TODAY)).toBe(true);
  });
  it('energy 0 (Crashed) still counts as logged', () => {
    const rows: HealthDay[] = [{ date: TODAY, energy: 0 }];
    expect(symptomsLoggedOn(rows, TODAY)).toBe(true);
  });
  it('is not logged when the row exists but energy is null', () => {
    const rows: HealthDay[] = [{ date: TODAY, energy: null, headache: 1 }];
    expect(symptomsLoggedOn(rows, TODAY)).toBe(false);
  });
  it('is not logged when the day has no row', () => {
    const rows: HealthDay[] = [{ date: '2026-07-07', energy: 3 }];
    expect(symptomsLoggedOn(rows, TODAY)).toBe(false);
    expect(symptomsLoggedOn(undefined, TODAY)).toBe(false);
  });
});

describe('symptomTip', () => {
  it('prefers the user definition for that level', () => {
    const defs = { brain_fog: { '2': 'Lose my train of thought mid-sentence' } };
    expect(symptomTip(defs, 'brain_fog', 2)).toBe('Lose my train of thought mid-sentence');
  });
  it('falls back to the generic scale when undefined', () => {
    expect(symptomTip({}, 'brain_fog', 2)).toBe('Moderate');
    expect(symptomTip(undefined, 'headache', 0)).toBe('None');
  });
  it('energy uses its own scale (0 is the bad end)', () => {
    expect(symptomTip({}, 'energy', 0)).toBe('Crashed');
    expect(symptomTip({}, 'energy', 3)).toBe('Great');
  });
});
