/**
 * sessionMountKey.test.ts — pins the rule that keeps a new session's first
 * reply streaming: the blank compose and the session it adopts share a key
 * (so the page isn't remounted mid-reply), while every other move still
 * remounts, including the next blank compose.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_MOUNT_KEY, adoptSession, mountKeyFor, type MountKeyState } from './sessionMountKey';

/** Walk a sequence of conversations, adopting where asked; return the keys. */
function keysFor(steps: (string | undefined | { adopt: string })[]): string[] {
  let state: MountKeyState = INITIAL_MOUNT_KEY;
  const keys: string[] = [];
  for (const step of steps) {
    if (typeof step === 'object') {
      state = adoptSession(state, step.adopt);
      continue;
    }
    const out = mountKeyFor(state, step);
    state = out.state;
    keys.push(out.key);
  }
  return keys;
}

describe('mountKeyFor', () => {
  it('keeps the blank compose key when it adopts the session it created', () => {
    const [blank, adopted] = keysFor([undefined, { adopt: 'A' }, 'A']);
    expect(adopted).toBe(blank);
  });

  it('remounts for a session that was not adopted', () => {
    const [blank, other] = keysFor([undefined, 'A']);
    expect(other).not.toBe(blank);
  });

  it('gives the next blank compose a fresh key after an adoption', () => {
    const [first, adopted, second] = keysFor([undefined, { adopt: 'A' }, 'A', undefined]);
    expect(adopted).toBe(first);
    expect(second).not.toBe(adopted);
  });

  it('remounts when leaving the adopted session for another one', () => {
    const [, adopted, other] = keysFor([undefined, { adopt: 'A' }, 'A', 'B']);
    expect(other).toBe('B');
    expect(other).not.toBe(adopted);
  });

  it('keys an ordinary conversation by its own id', () => {
    expect(keysFor(['A', 'B'])).toEqual(['A', 'B']);
  });
});
