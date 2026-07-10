import { describe, expect, it } from 'vitest';
import {
  EDITOR_URL,
  REDIRECT_DELAY_MS,
  STATUS_POLL_MS,
  STOP_SETTLE_MS,
  formatMb,
  formatMemText,
  isMemLow,
  memPercent,
  showLowMemWarning,
  warnDetail,
} from './vscodeMath';

describe('memPercent', () => {
  it('rounds to the nearest whole percent like the old gauge', () => {
    expect(memPercent(1234, 3921)).toBe(31); // 31.47… → 31
    expect(memPercent(500, 1000)).toBe(50);
    expect(memPercent(996, 1000)).toBe(100); // 99.6 rounds up
  });

  it('clamps at 100 even if available exceeds total', () => {
    expect(memPercent(5000, 4000)).toBe(100);
  });

  it('is 0 for empty, zero-total, or garbage inputs instead of NaN', () => {
    expect(memPercent(0, 4000)).toBe(0);
    expect(memPercent(1000, 0)).toBe(0);
    expect(memPercent(Number.NaN, 4000)).toBe(0);
    expect(memPercent(-50, 4000)).toBe(0);
  });
});

describe('byte formatting', () => {
  it('prints raw whole megabytes like the old page', () => {
    expect(formatMb(842)).toBe('842 MB');
  });

  it('formats the gauge value line as "avail MB / total MB"', () => {
    expect(formatMemText(1234, 3921)).toBe('1234 MB / 3921 MB');
  });
});

describe('low-memory threshold', () => {
  it('marks the gauge low only when not ok to start AND not running', () => {
    expect(isMemLow({ ok_to_start: false, running: false })).toBe(true);
    expect(isMemLow({ ok_to_start: false, running: true })).toBe(false);
    expect(isMemLow({ ok_to_start: true, running: false })).toBe(false);
    expect(isMemLow({ ok_to_start: true, running: true })).toBe(false);
  });

  it('shows the warning card under the same condition', () => {
    expect(showLowMemWarning({ ok_to_start: false, running: false })).toBe(true);
    expect(showLowMemWarning({ ok_to_start: true, running: false })).toBe(false);
    expect(showLowMemWarning({ ok_to_start: false, running: true })).toBe(false);
  });

  it('keeps the old warning copy verbatim', () => {
    expect(warnDetail(1500)).toBe('Need ~1500 MB free. Close some of these to make room:');
  });
});

describe('launcher timing + redirect constants (parity with the old page)', () => {
  it('polls status every second while starting', () => {
    expect(STATUS_POLL_MS).toBe(1000);
  });

  it('redirects 400ms after the running transition', () => {
    expect(REDIRECT_DELAY_MS).toBe(400);
  });

  it('waits 800ms after stop before re-checking', () => {
    expect(STOP_SETTLE_MS).toBe(800);
  });

  it('targets the code-server proxy with its trailing slash, not the SPA /files route', () => {
    expect(EDITOR_URL).toBe('/files/');
  });
});
