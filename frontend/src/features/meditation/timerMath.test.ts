import { describe, expect, it } from 'vitest';
import { elapsedToDurationMin, formatElapsed, parseTimerState } from './timerMath';

describe('parseTimerState', () => {
  it('returns null for missing/empty raw value', () => {
    expect(parseTimerState(null)).toBeNull();
    expect(parseTimerState('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseTimerState('{not json')).toBeNull();
  });

  it('returns null when type or started_at is missing', () => {
    expect(parseTimerState(JSON.stringify({ type: 'sitting' }))).toBeNull();
    expect(parseTimerState(JSON.stringify({ started_at: 123 }))).toBeNull();
    expect(parseTimerState(JSON.stringify({ type: '', started_at: 123 }))).toBeNull();
  });

  it('returns null for non-object payloads', () => {
    expect(parseTimerState('"sitting"')).toBeNull();
    expect(parseTimerState('null')).toBeNull();
  });

  it('parses a valid state', () => {
    expect(parseTimerState(JSON.stringify({ type: 'metta', started_at: 1000 }))).toEqual({
      type: 'metta',
      started_at: 1000,
    });
  });
});

describe('formatElapsed', () => {
  it('formats under a minute as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9_000)).toBe('0:09');
    expect(formatElapsed(59_999)).toBe('0:59');
  });

  it('formats minutes without zero-padding the minute', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(605_000)).toBe('10:05');
  });

  it('switches to h:mm:ss at an hour, padding minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_600_000 + 5 * 60_000 + 7_000)).toBe('1:05:07');
  });

  it('clamps negative elapsed to zero', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
  });
});

describe('elapsedToDurationMin', () => {
  it('never logs less than one minute', () => {
    expect(elapsedToDurationMin(0)).toBe(1);
    expect(elapsedToDurationMin(10_000)).toBe(1);
  });

  it('rounds to the nearest whole minute', () => {
    expect(elapsedToDurationMin(89_999)).toBe(1); // 1.49min
    expect(elapsedToDurationMin(90_000)).toBe(2); // 1.5min
    expect(elapsedToDurationMin(25 * 60_000)).toBe(25);
  });
});
