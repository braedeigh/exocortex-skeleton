import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchIntent, registerIntentTarget, resetBusForTests, type Intent } from './windowBus';

afterEach(() => resetBusForTests());

describe('dispatching within one window', () => {
  it('reports none when nothing will take it, so the caller can navigate', () => {
    expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'server.py' })).toBe('none');
  });

  it('delivers to a target that accepts the kind', () => {
    const got: Intent[] = [];
    registerIntentTarget(['code'], (i) => got.push(i));
    expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'server.py' })).toBe('local');
    expect(got).toEqual([{ kind: 'code', repo: 'skeleton', path: 'server.py' }]);
  });

  it('ignores targets that do not accept the kind', () => {
    const got: Intent[] = [];
    registerIntentTarget(['conversation'], (i) => got.push(i));
    expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' })).toBe('none');
    expect(got).toHaveLength(0);
  });

  it('routes each kind to the target that claimed it', () => {
    const code: Intent[] = [];
    const convo: Intent[] = [];
    registerIntentTarget(['code'], (i) => code.push(i));
    registerIntentTarget(['conversation', 'session'], (i) => convo.push(i));
    dispatchIntent({ kind: 'code', repo: 'vault', path: 'x.md' });
    dispatchIntent({ kind: 'conversation', convId: 'c1' });
    dispatchIntent({ kind: 'session', name: 'chat' });
    expect(code).toHaveLength(1);
    expect(convo).toHaveLength(2);
  });
});

describe('two tiles of the same kind', () => {
  it('sends to the most recently registered', () => {
    const first: Intent[] = [];
    const second: Intent[] = [];
    registerIntentTarget(['code'], (i) => first.push(i));
    registerIntentTarget(['code'], (i) => second.push(i));
    dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' });
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it('sends to whichever was touched last, not whichever opened last', () => {
    const first: Intent[] = [];
    const second: Intent[] = [];
    const a = registerIntentTarget(['code'], (i) => first.push(i));
    registerIntentTarget(['code'], (i) => second.push(i));
    a.bump(); // she clicked back into the first tile
    dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('falls back to the remaining tile when one closes', () => {
    const first: Intent[] = [];
    const second: Intent[] = [];
    registerIntentTarget(['code'], (i) => first.push(i));
    const b = registerIntentTarget(['code'], (i) => second.push(i));
    b.unregister();
    dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' });
    expect(first).toHaveLength(1);
  });

  it('reports none again once every target has gone', () => {
    const a = registerIntentTarget(['code'], () => {});
    a.unregister();
    expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' })).toBe('none');
  });
});

describe('reaching another window', () => {
  it('posts to a window that announced the kind, rather than reporting none', () => {
    if (typeof BroadcastChannel === 'undefined') return; // not in this environment
    const other = new BroadcastChannel('exo-window-bus');
    const seen: unknown[] = [];
    other.onmessage = (e) => seen.push(e.data);

    // Wake our own channel, then play the part of a second window announcing
    // that it holds a code tile.
    registerIntentTarget(['conversation'], () => {});
    const announcer = new BroadcastChannel('exo-window-bus');
    announcer.postMessage({ t: 'caps', from: 'other-window', kinds: ['code'] });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'server.py' });
        expect(result).toBe('remote');
        setTimeout(() => {
          const sent = seen.find(
            (m): m is { t: string; to: string } =>
              typeof m === 'object' && m !== null && (m as { t?: string }).t === 'intent',
          );
          expect(sent?.to).toBe('other-window');
          other.close();
          announcer.close();
          resolve();
        }, 20);
      }, 20);
    });
  });

  it('prefers a tile in this window over one in another', () => {
    if (typeof BroadcastChannel === 'undefined') return;
    const got: Intent[] = [];
    registerIntentTarget(['code'], (i) => got.push(i));
    const announcer = new BroadcastChannel('exo-window-bus');
    announcer.postMessage({ t: 'caps', from: 'other-window', kinds: ['code'] });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' })).toBe('local');
        expect(got).toHaveLength(1);
        announcer.close();
        resolve();
      }, 20);
    });
  });

  it('forgets a window whose announcement has gone stale', () => {
    if (typeof BroadcastChannel === 'undefined') return;
    registerIntentTarget(['conversation'], () => {});
    const announcer = new BroadcastChannel('exo-window-bus');
    announcer.postMessage({ t: 'caps', from: 'ghost', kinds: ['code'] });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 60_000); // past the staleness horizon
        expect(dispatchIntent({ kind: 'code', repo: 'skeleton', path: 'a.py' })).toBe('none');
        vi.useRealTimers();
        announcer.close();
        resolve();
      }, 20);
    });
  });
});
