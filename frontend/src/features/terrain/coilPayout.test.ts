import { describe, expect, it } from 'vitest';
import {
  PAYOUT_SLIDE_MS,
  PAYOUT_STEP_MS,
  PAYOUT_TOTAL_MS,
  payoutDurationMs,
  payoutProgress,
  payoutStepMs,
} from './coilPayout';

/**
 * coilPayout.test.ts — a pull pays its dots out one at a time, and never
 * takes much longer than two seconds however many it brings out.
 */

describe('payoutStepMs', () => {
  it('keeps the one-at-a-time pace for a small pull', () => {
    expect(payoutStepMs(20)).toBe(PAYOUT_STEP_MS);
  });

  it('shrinks the gap so a big pull still finishes in about two seconds', () => {
    expect(payoutDurationMs(600)).toBeLessThanOrEqual(PAYOUT_TOTAL_MS + PAYOUT_SLIDE_MS);
  });
});

describe('payoutProgress', () => {
  it('brings them out in order, not all at once', () => {
    const at = PAYOUT_STEP_MS * 2.5;
    expect(payoutProgress(at, 0, PAYOUT_STEP_MS)).toBeGreaterThan(0);
    expect(payoutProgress(at, 2, PAYOUT_STEP_MS)).toBeGreaterThanOrEqual(0);
    expect(payoutProgress(at, 3, PAYOUT_STEP_MS)).toBeLessThan(0);
  });

  it('lands each dot in place once its slide is over', () => {
    expect(payoutProgress(PAYOUT_SLIDE_MS, 0, PAYOUT_STEP_MS)).toBe(1);
  });
});
