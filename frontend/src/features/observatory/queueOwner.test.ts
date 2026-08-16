import { afterEach, describe, expect, it, vi } from 'vitest';
import { claim, ownerOf, release, resetQueueOwnersForTests, subscribe, takeOver } from './queueOwner';

afterEach(() => resetQueueOwnersForTests());

describe('one view fires, the rest hold', () => {
  it('gives the claim to the first view of a conversation', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    expect(claim('c1', first)).toBe(true);
    expect(claim('c1', second)).toBe(false);
    expect(ownerOf('c1')).toBe(first);
  });

  it('lets the holder confirm its own claim without losing it', () => {
    const token = Symbol('a');
    expect(claim('c1', token)).toBe(true);
    expect(claim('c1', token)).toBe(true);
    expect(ownerOf('c1')).toBe(token);
  });

  it('keeps conversations independent', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(claim('c1', a)).toBe(true);
    expect(claim('c2', b)).toBe(true);
    expect(ownerOf('c1')).toBe(a);
    expect(ownerOf('c2')).toBe(b);
  });
});

describe('handing the claim on', () => {
  it('frees it when the holder goes away', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    claim('c1', first);
    release('c1', first);
    expect(ownerOf('c1')).toBeUndefined();
    expect(claim('c1', second)).toBe(true);
  });

  it('ignores a release from a view that no longer holds it', () => {
    // The closing tab was not the owner — it must not free someone else's
    // claim on the way out, or two views end up firing again.
    const first = Symbol('first');
    const second = Symbol('second');
    claim('c1', first);
    release('c1', second);
    expect(ownerOf('c1')).toBe(first);
  });

  it('tells waiting views when the claim frees up', () => {
    const first = Symbol('first');
    const heard = vi.fn();
    claim('c1', first);
    const unsub = subscribe('c1', heard);
    release('c1', first);
    expect(heard).toHaveBeenCalled();
    unsub();
  });

  it('stops telling a view that unsubscribed', () => {
    const heard = vi.fn();
    const unsub = subscribe('c1', heard);
    unsub();
    claim('c1', Symbol('a'));
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('the view she is typing in wins', () => {
  it('takes the claim from whoever mounted first', () => {
    // Otherwise a message queued in the second view is held by a view that
    // isn't allowed to send it, and never goes out.
    const first = Symbol('first');
    const second = Symbol('second');
    claim('c1', first);
    takeOver('c1', second);
    expect(ownerOf('c1')).toBe(second);
  });

  it('is a no-op, and tells nobody, when it already holds the claim', () => {
    const token = Symbol('a');
    claim('c1', token);
    const heard = vi.fn();
    const unsub = subscribe('c1', heard);
    takeOver('c1', token);
    expect(heard).not.toHaveBeenCalled();
    expect(ownerOf('c1')).toBe(token);
    unsub();
  });

  it('leaves the previous holder unable to free the claim it lost', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    claim('c1', first);
    takeOver('c1', second);
    release('c1', first);
    expect(ownerOf('c1')).toBe(second);
  });
});
