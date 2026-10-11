import { describe, expect, it } from 'vitest';
import type { SpinoffTreeNode } from './api';
import { buildSpinoffTree, treeTitle } from './spinoffTree';

function node(id: string, started: string, parent: string | null = null): SpinoffTreeNode {
  return {
    id, title: `spin: ${id}`, slug: id, lane: 'coding', started, last: null,
    archived: false, running: false, parent, via: parent ? 'skill' : null,
  };
}

describe('buildSpinoffTree', () => {
  it('nests children under their parent, oldest child first', () => {
    const [root] = buildSpinoffTree([
      node('p', '2026-09-01'), node('b', '2026-09-03', 'p'), node('a', '2026-09-02', 'p'),
    ]);
    expect(root.node.id).toBe('p');
    expect(root.children.map((c) => c.node.id)).toEqual(['a', 'b']);
  });

  it('puts the family that grew most recently first', () => {
    const roots = buildSpinoffTree([
      node('old', '2026-09-01'), node('new', '2026-09-02'), node('late-child', '2026-09-09', 'old'),
    ]);
    expect(roots.map((r) => r.node.id)).toEqual(['old', 'new']);
  });

  it('treats a missing parent as a root and survives a loop', () => {
    const roots = buildSpinoffTree([node('x', '2026-09-01', 'gone'), node('y', '2026-09-01', 'y')]);
    expect(roots.map((r) => r.node.id).sort()).toEqual(['x', 'y']);
  });
});

it('treeTitle drops the spawn prefix', () => {
  expect(treeTitle(node('keeper-chat', ''))).toBe('keeper-chat');
});
