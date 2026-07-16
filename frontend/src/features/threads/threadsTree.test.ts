import { describe, expect, it } from 'vitest';
import {
  alsoUnder,
  anyThreadHasFronts,
  buildVisibleTree,
  filterByFront,
  grandchildNotes,
  isPrimaryFront,
  partitionByStatus,
} from './threadsTree';
import type { Thread, ThreadsTreeResponse, ThreadTreeNode } from '../journal/types';

function node(overrides: Partial<ThreadTreeNode> & { name: string }): ThreadTreeNode {
  return { fronts: [], parents: [], people: [], kind: null, status: '', children: [], ...overrides };
}

/** long-covid (root)
 *    -> migraines (also under job-hub)
 *    -> the-body
 * job-hub (root)
 *    -> migraines (also under long-covid)
 * dormant-hub (root, dormant)
 *    -> orphan-child (still active — should be promoted to a root)
 * retired-thing (root, retired) */
function sampleTree(): ThreadsTreeResponse {
  return {
    roots: ['dormant-hub', 'job-hub', 'long-covid', 'retired-thing'],
    nodes: {
      'long-covid': node({ name: 'Long Covid', children: ['migraines', 'the-body'] }),
      'job-hub': node({ name: 'Job', children: ['migraines'] }),
      migraines: node({ name: 'Migraines', parents: ['long-covid', 'job-hub'], fronts: ['health', 'job'] }),
      'the-body': node({ name: 'The Body', parents: ['long-covid'], children: ['grandkid'] }),
      grandkid: node({ name: 'Grandkid', parents: ['the-body'] }),
      'dormant-hub': node({ name: 'Dormant Hub', status: 'dormant', children: ['orphan-child'] }),
      'orphan-child': node({ name: 'Orphan Child', parents: ['dormant-hub'] }),
      'retired-thing': node({ name: 'Retired Thing', status: 'retired' }),
    },
  };
}

describe('partitionByStatus', () => {
  it('splits nodes into visible/dormant/retired buckets', () => {
    const { visible, dormant, retired } = partitionByStatus(sampleTree().nodes);
    expect(dormant).toEqual(['dormant-hub']);
    expect(retired).toEqual(['retired-thing']);
    expect(visible.sort()).toEqual(
      ['long-covid', 'job-hub', 'migraines', 'the-body', 'grandkid', 'orphan-child'].sort(),
    );
  });
});

describe('buildVisibleTree', () => {
  it('keeps ordinary roots and their filtered children', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(vt.roots).toContain('long-covid');
    expect(vt.roots).toContain('job-hub');
    expect(vt.childrenByRoot['long-covid']).toEqual(['migraines', 'the-body']);
    expect(vt.childrenByRoot['job-hub']).toEqual(['migraines']);
  });

  it('does not promote a root that is itself dormant/retired', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(vt.roots).not.toContain('dormant-hub');
    expect(vt.roots).not.toContain('retired-thing');
  });

  it('promotes a child whose only parent is dormant to a root', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(vt.roots).toContain('orphan-child');
    expect(vt.childrenByRoot['orphan-child']).toEqual([]);
  });

  it('a node with two living parents appears under both', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(vt.childrenByRoot['long-covid']).toContain('migraines');
    expect(vt.childrenByRoot['job-hub']).toContain('migraines');
  });
});

describe('alsoUnder', () => {
  it('names the other parent for a multi-parent depth-1 node', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(alsoUnder(vt, tree, 'migraines', 'long-covid')).toEqual(['Job']);
    expect(alsoUnder(vt, tree, 'migraines', 'job-hub')).toEqual(['Long Covid']);
  });

  it('is empty for a single-parent node', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(alsoUnder(vt, tree, 'the-body', 'long-covid')).toEqual([]);
  });
});

describe('grandchildNotes', () => {
  it('names a grandchild not independently visible elsewhere', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    const notes = grandchildNotes(tree, vt, 'the-body');
    expect(notes).toEqual([{ slug: 'grandkid', name: 'Grandkid', visible: false }]);
  });

  it('flags a grandchild visible when it was promoted to a root of its own', () => {
    // orphan-child is dormant-hub's child, but got promoted to a root of its own.
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    const notes = grandchildNotes(tree, vt, 'dormant-hub');
    expect(notes).toEqual([{ slug: 'orphan-child', name: 'Orphan Child', visible: true }]);
  });

  it('is empty for a leaf node', () => {
    const tree = sampleTree();
    const { visible } = partitionByStatus(tree.nodes);
    const vt = buildVisibleTree(tree, visible);
    expect(grandchildNotes(tree, vt, 'migraines')).toEqual([]);
  });
});

function thread(overrides: Partial<Thread> & { id: string; name: string }): Thread {
  return { file: `Threads/${overrides.id}.md`, aliases: [], ...overrides };
}

describe('filterByFront', () => {
  it('keeps only threads carrying the front id, sorted by name', () => {
    const threads = [
      thread({ id: 'b', name: 'Bravo', fronts: ['job'] }),
      thread({ id: 'a', name: 'Alpha', fronts: ['health', 'job'] }),
      thread({ id: 'c', name: 'Charlie', fronts: ['health'] }),
    ];
    expect(filterByFront(threads, 'job').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('degrades gracefully when fronts is missing (un-migrated data)', () => {
    const threads = [thread({ id: 'a', name: 'Alpha' })];
    expect(filterByFront(threads, 'health')).toEqual([]);
  });
});

describe('isPrimaryFront', () => {
  it('is true only when the lens front is first in the list', () => {
    const t = thread({ id: 'a', name: 'Alpha', fronts: ['health', 'job'] });
    expect(isPrimaryFront(t, 'health')).toBe(true);
    expect(isPrimaryFront(t, 'job')).toBe(false);
  });

  it('is false when fronts is missing', () => {
    expect(isPrimaryFront(thread({ id: 'a', name: 'Alpha' }), 'health')).toBe(false);
  });
});

describe('anyThreadHasFronts', () => {
  it('is false when every thread is un-migrated (no fronts anywhere)', () => {
    const threads = [thread({ id: 'a', name: 'Alpha' }), thread({ id: 'b', name: 'Bravo', fronts: [] })];
    expect(anyThreadHasFronts(threads)).toBe(false);
  });

  it('is true once at least one thread carries a front', () => {
    const threads = [thread({ id: 'a', name: 'Alpha' }), thread({ id: 'b', name: 'Bravo', fronts: ['job'] })];
    expect(anyThreadHasFronts(threads)).toBe(true);
  });
});
