import { describe, expect, it } from 'vitest';
import { intentKindsForUrl, urlForIntent } from './panelIntents';

describe('what a tile catches, from the page it shows', () => {
  it('a code tile catches code, with or without a file already open', () => {
    expect(intentKindsForUrl('/code')).toEqual(['code']);
    expect(intentKindsForUrl('/code?repo=skeleton&path=server.py')).toEqual(['code']);
  });

  it('observatory tiles do NOT catch for themselves — the window rules on conversations', () => {
    // Where a conversation opens is the workspace's window-level decision
    // (conversationRouting.ts); a tile catching here would shadow that rule.
    expect(intentKindsForUrl('/observatory')).toEqual([]);
    expect(intentKindsForUrl('/observatory/session?conv=abc')).toEqual([]);
    expect(intentKindsForUrl('/observatory/archive')).toEqual([]);
  });

  it('an ordinary page catches nothing', () => {
    expect(intentKindsForUrl('/todos')).toEqual([]);
    expect(intentKindsForUrl('/terrain/map')).toEqual([]);
    expect(intentKindsForUrl('/')).toEqual([]);
  });

  it('is not fooled by a page whose name merely starts the same way', () => {
    expect(intentKindsForUrl('/codex')).toEqual([]);
    expect(intentKindsForUrl('/observatories')).toEqual([]);
  });

  it('ignores a trailing slash', () => {
    expect(intentKindsForUrl('/code/')).toEqual(['code']);
  });
});

describe('where a caught thing sends the tile', () => {
  it('builds a code url with both parameters escaped', () => {
    expect(urlForIntent({ kind: 'code', repo: 'skeleton', path: 'routes/observatory.py' })).toBe(
      '/code?repo=skeleton&path=routes%2Fobservatory.py',
    );
  });

  it('builds a conversation url on the placeholder segment', () => {
    expect(urlForIntent({ kind: 'conversation', convId: 'abc123' })).toBe(
      '/observatory/session?conv=abc123',
    );
  });

  it('has nowhere to send a tmux session — that is the terminal, not a page', () => {
    expect(urlForIntent({ kind: 'session', name: 'chat' })).toBeNull();
  });
});
