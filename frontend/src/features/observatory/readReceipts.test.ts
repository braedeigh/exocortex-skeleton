/**
 * readReceipts.test.ts — pins isUnread, the one comparison behind both the
 * roster's unread dot and the observatory's open-at-unread scroll anchor.
 * The trap it guards: the server stamps last_at in ZONELESS local time
 * ("2026-08-03T14:00:00") while this store stamps UTC-with-Z — the two are
 * lexically incomparable, so the comparison must go through Date.parse.
 *
 * A zoneless stamp parses in the MACHINE's zone, so these tests keep every
 * mixed-format pair more than a day apart — wider than any UTC offset on
 * earth — and stay deterministic in whatever zone they run.
 */
import { describe, expect, it } from 'vitest';
import { isUnread } from './readReceipts';

describe('isUnread', () => {
  it('activity after the open stamp is unread', () => {
    expect(isUnread('2026-08-05T12:00:00', '2026-08-03T12:00:00Z')).toBe(true);
  });

  it('an open stamp after the last activity is read', () => {
    expect(isUnread('2026-08-03T12:00:00', '2026-08-05T12:00:00Z')).toBe(false);
  });

  it('compares same-format stamps to the second', () => {
    // Same format on both sides — no zone ambiguity, tight bound is safe.
    expect(isUnread('2026-08-03T12:00:05Z', '2026-08-03T12:00:00Z')).toBe(true);
    expect(isUnread('2026-08-03T12:00:00Z', '2026-08-03T12:00:05Z')).toBe(false);
  });

  it('compares the mixed stamp formats on one clock, not as strings', () => {
    // Lexically, 'Z' sorts before a zoneless tail — string order would call
    // the earlier UTC stamp "later". Date.parse must not.
    expect(isUnread('2026-08-05T00:00:00', '2026-08-03T00:00:00Z')).toBe(true);
  });

  it('never opened means unread the moment there is any activity', () => {
    expect(isUnread('2026-08-03T12:00:00', null)).toBe(true);
    expect(isUnread('2026-08-03T12:00:00', undefined)).toBe(true);
  });

  it('no activity at all is never unread, whatever the open state', () => {
    expect(isUnread(undefined, null)).toBe(false);
    expect(isUnread('', '2026-08-03T12:00:00Z')).toBe(false);
    expect(isUnread(42, null)).toBe(false);
  });
});
