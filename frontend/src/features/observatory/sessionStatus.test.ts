/**
 * sessionStatus.test.ts — pins the card's "Xm ago" stamp: largest unit that
 * still says something, the server's zoneless local stamps and UTC-with-Z
 * stamps landing on one clock, clock skew clamped to "just now" instead of a
 * negative age, and no stamp at all yielding no line rather than a fake one.
 */
import { describe, expect, it } from 'vitest';
import { lastActivityLabel } from './sessionStatus';

describe('lastActivityLabel', () => {
  const NOW = Date.parse('2026-07-27T12:00:00Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('reads the age in the largest unit that still says something', () => {
    expect(lastActivityLabel(at(30_000), NOW)).toBe('just now');
    expect(lastActivityLabel(at(4 * 60_000), NOW)).toBe('4m ago');
    expect(lastActivityLabel(at(3 * 3600_000), NOW)).toBe('3h ago');
    expect(lastActivityLabel(at(2 * 86_400_000), NOW)).toBe('2d ago');
    expect(lastActivityLabel(at(60 * 86_400_000), NOW)).toBe('2mo ago');
  });

  it('parses the server’s zoneless stamp onto the same clock as a UTC one', () => {
    // The index stamps local time with no offset; other stamps carry Z. Both
    // must land on the same clock — string maths would put them worlds apart.
    const zoneless = '2026-07-27T11:58:00';
    const label = lastActivityLabel(zoneless, Date.parse('2026-07-27T11:59:00'));
    expect(label).toBe('1m ago');
  });

  it('clamps a future stamp instead of printing a negative age', () => {
    // Clock skew between the box and her phone must not read as "-3m ago".
    expect(lastActivityLabel(at(-3 * 60_000), NOW)).toBe('just now');
  });

  it('says nothing at all when there is no usable stamp', () => {
    // A session that has never run gets no line, rather than a fake "just now".
    expect(lastActivityLabel(undefined, NOW)).toBeNull();
    expect(lastActivityLabel('', NOW)).toBeNull();
    expect(lastActivityLabel('not a date', NOW)).toBeNull();
  });
});
