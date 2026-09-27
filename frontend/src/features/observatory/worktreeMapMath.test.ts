import { describe, expect, it } from 'vitest';
import type { Tree, TreeAgent } from './worktreeMapApi';
import { footprint, orbRadius, orderTrees, recencyOf, treeName, writersNow } from './worktreeMapMath';

const NOW = Date.parse('2026-09-27T12:00:00');

function agent(over: Partial<TreeAgent>): TreeAgent {
  return {
    conv: 'c', title: 'T', lane: 'coding', home: false, edited: 0, ran: 0, looked: 0,
    first_at: '2026-09-27T11:00:00', last_at: '2026-09-27T11:59:00', last_write_at: null,
    files: [], recent: [], ...over,
  };
}

function tree(over: Partial<Tree>): Tree {
  return {
    path: '/w/x', repo: 'skeleton', branch: 'main', head: 'abc', main: false, main_branch: 'main',
    missing: false, ahead: null, behind: null, dirty: null, last_commit_at: null, agents: [], ...over,
  };
}

describe('recencyOf', () => {
  it('is live within two minutes, recent within ten, earlier after', () => {
    expect([
      recencyOf('2026-09-27T11:59:00', NOW),
      recencyOf('2026-09-27T11:55:00', NOW),
      recencyOf('2026-09-27T11:00:00', NOW),
    ]).toEqual(['live', 'recent', 'earlier']);
  });
  it('treats a missing stamp as earlier', () => {
    expect(recencyOf(null, NOW)).toBe('earlier');
  });
});

describe('orbRadius', () => {
  it('grows with work but stays inside the plot', () => {
    expect([orbRadius({ edited: 0, ran: 0, looked: 0 }), orbRadius({ edited: 500, ran: 500, looked: 0 })]).toEqual([13, 30]);
  });
});

describe('footprint', () => {
  it('splits work into shares, and an idle agent is all ash', () => {
    expect([footprint({ edited: 1, ran: 3, looked: 0 }), footprint({ edited: 0, ran: 0, looked: 0 })]).toEqual([
      { edited: 0.25, ran: 0.75, looked: 0 },
      { edited: 0, ran: 0, looked: 1 },
    ]);
  });
});

describe('writersNow', () => {
  it('counts only agents that wrote in the last ten minutes', () => {
    const t = tree({
      agents: [
        agent({ conv: 'a', last_write_at: '2026-09-27T11:58:00' }),
        agent({ conv: 'b', last_write_at: '2026-09-27T10:00:00' }),
        agent({ conv: 'c', last_write_at: null }),
      ],
    });
    expect(writersNow(t, NOW).map((a) => a.conv)).toEqual(['a']);
  });
});

describe('orderTrees', () => {
  it('puts trees with writers first, then main checkouts before copies', () => {
    const busy = tree({ path: '/w/busy', agents: [agent({ last_write_at: '2026-09-27T11:00:00' })] });
    const main = tree({ path: '/w/main', main: true });
    const copy = tree({ path: '/w/copy' });
    expect(orderTrees([copy, main, busy]).map(treeName)).toEqual(['busy', 'main', 'copy']);
  });
});
