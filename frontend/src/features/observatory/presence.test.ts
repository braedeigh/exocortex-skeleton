/**
 * presence.test.ts — pins the one pure contract in presence.ts: a session is
 * "open" while its last heartbeat is within the TTL (inclusive), a stale or
 * unparseable stamp silently ages out, and the clock is injected so none of
 * this depends on when the test runs. (Was openSessionsStore.test.ts until
 * the 08-03 rename.)
 */
import { describe, expect, it } from 'vitest';
import { freshOpenIds } from './presence';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('freshOpenIds', () => {
  it('keeps ids stamped within the ttl and drops older ones', () => {
    const map = {
      'a': iso(60_000), // 1 min ago — open
      'b': iso(29 * 60_000), // 29 min ago — open (ttl 30)
      'c': iso(31 * 60_000), // 31 min ago — aged out
    };
    const open = freshOpenIds(map, 30 * 60_000, NOW);
    expect([...open].sort()).toEqual(['a', 'b']);
  });

  it('treats an exactly-ttl-old stamp as still open (inclusive bound)', () => {
    const open = freshOpenIds({ a: iso(30 * 60_000) }, 30 * 60_000, NOW);
    expect(open.has('a')).toBe(true);
  });

  it('ignores an unparseable stamp rather than throwing', () => {
    const open = freshOpenIds({ a: 'not-a-date', b: iso(0) }, 30 * 60_000, NOW);
    expect(open.has('a')).toBe(false);
    expect(open.has('b')).toBe(true);
  });

  it('returns an empty set for an empty map', () => {
    expect(freshOpenIds({}, 30 * 60_000, NOW).size).toBe(0);
  });
});
