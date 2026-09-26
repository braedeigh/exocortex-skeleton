import { describe, expect, it } from 'vitest';
import { cellHeadline, cellReview, formatAmount, hazardAndBelow, mapLines } from './tableMath';
import type { Hazard, MeasureSummary } from './types';

const hazard = (id: number, name: string, parents: number[] = []): Hazard => ({
  id,
  name,
  note: null,
  names: [],
  parents,
  measure_count: 0,
});

const measure = (id: number, over: Partial<MeasureSummary> = {}): MeasureSummary => ({
  id,
  hazard_id: 1,
  hazard: 'Lead',
  measure: 'concentration',
  amount: 12,
  unit: 'ppb',
  year: 2020,
  measured_on: null,
  review: 'confirmed',
  author: 'llm',
  sourced: true,
  ...over,
});

describe('formatAmount', () => {
  it('writes percents tight and other units spaced', () => {
    expect(formatAmount(89.1, '%')).toBe('89.1%');
    expect(formatAmount(12, 'ppb')).toBe('12 ppb');
  });
});

describe('cellReview', () => {
  it('shows the state that most needs her', () => {
    expect(cellReview([measure(1), measure(2, { review: 'unreviewed' })])).toBe('unreviewed');
    expect(cellReview([measure(1, { review: 'unreviewed' }), measure(2, { review: 'disputed' })])).toBe('disputed');
    expect(cellReview([measure(1)])).toBe('confirmed');
  });
});

describe('cellHeadline', () => {
  it('never leads with a different kind of number than the table shows', () => {
    const entries = [measure(1, { measure: 'detection_rate', amount: 90, unit: '%' }), measure(2)];
    expect(cellHeadline(entries, 'concentration')?.id).toBe(2);
  });
});

describe('mapLines', () => {
  it('draws a hazard with two parents under both', () => {
    const map = [hazard(1, 'Contaminant'), hazard(2, 'Pesticide', [1]), hazard(3, 'POP', [1]), hazard(4, 'DDE', [2, 3])];
    const lines = mapLines(map);
    expect(lines.filter((line) => line.hazard.id === 4).map((line) => line.depth)).toEqual([2, 2]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });
});

describe('hazardAndBelow', () => {
  it('includes every descendant, however far down', () => {
    const map = [hazard(1, 'A'), hazard(2, 'B', [1]), hazard(3, 'C', [2]), hazard(4, 'D')];
    expect([...hazardAndBelow(map, 1)].sort()).toEqual([1, 2, 3]);
  });
});
