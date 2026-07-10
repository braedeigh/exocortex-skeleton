import { describe, expect, it } from 'vitest';
import { asString, findHealthRow, payloadRecord, todayISO } from './shared';
import type { HealthDay } from '../todos/types';

describe('payloadRecord', () => {
  it('returns the payload when it is a JSON object', () => {
    expect(payloadRecord({ payload: { a: 1, b: 'x' } })).toEqual({ a: 1, b: 'x' });
  });

  it.each([
    ['null', null],
    ['array', [1, 2]],
    ['string', 'oops'],
  ])('degrades a %s payload to an empty record', (_label, payload) => {
    expect(payloadRecord({ payload })).toEqual({});
  });
});

describe('asString', () => {
  it('reads null/undefined as empty — the legacy `p.field || ""` idiom', () => {
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
  });

  it('stringifies scalars the way form inputs expect', () => {
    expect(asString(30)).toBe('30');
    expect(asString('now')).toBe('now');
    expect(asString(false)).toBe('false');
  });
});

describe('todayISO', () => {
  it('produces a YYYY-MM-DD string', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('findHealthRow', () => {
  const rows: HealthDay[] = [
    { date: '2026-07-08', energy: 2 },
    { date: '2026-07-09', energy: 1 },
  ];

  it('finds the row for the date', () => {
    expect(findHealthRow(rows, '2026-07-09')).toEqual({ date: '2026-07-09', energy: 1 });
  });

  it('is null when the date has no row or data is missing', () => {
    expect(findHealthRow(rows, '2026-01-01')).toBeNull();
    expect(findHealthRow(undefined, '2026-07-09')).toBeNull();
  });
});
