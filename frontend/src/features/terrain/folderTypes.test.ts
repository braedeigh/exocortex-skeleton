import { describe, expect, it } from 'vitest';
import { childTypeCounts, liveliestBeneath } from './folderTypes';
import type { TerrainNode } from './terrainGraph';

/**
 * folderTypes.test.ts — the roll-up behind a folder's outline under the map's
 * "Types" toggle (folderTypes.ts): every file type anywhere beneath a folder,
 * ranked commonest first, counted over the files still on screen. The canvas
 * paints each one its share of the border, so both the ORDER and the COUNTS
 * matter here.
 *
 * Five things would break silently rather than visibly, which is why they're
 * pinned: that the count goes all the way DOWN and not one level; that the
 * counts are the real file counts (they become the shares of the outline);
 * that the All / Recent / Old switch narrows it; that "Other" never outranks
 * a real language; and that a tie settles the same way every frame, so a
 * folder can't flicker between two colours.
 *
 * liveliestBeneath is the other half of the same walk: how alive a folder's
 * liveliest file is, which is how present the folder itself gets to be. Its
 * one load-bearing choice is MAX rather than a mean — one file changed this
 * morning has to keep its whole branch lit, however much dead weight sits
 * beside it.
 */

/** A file node at `path`, hung under `parentId`. */
function file(id: string, path: string, parentId: string): TerrainNode {
  return {
    id,
    kind: 'file',
    label: path.split('/').pop() ?? path,
    parentId,
    depth: 2,
    repoId: 'repo',
    path,
    heat: 0,
    file: { path, touches: [], sessions: [] },
  };
}

/** A folder node. */
function dir(id: string, parentId: string | null): TerrainNode {
  return { id, kind: 'dir', label: id, parentId, depth: 1, repoId: 'repo', heat: 0 };
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

describe('childTypeCounts', () => {
  it('names the commonest type in a folder', () => {
    const nodes = [
      dir('routes', null),
      file('a', 'routes/a.py', 'routes'),
      file('b', 'routes/b.py', 'routes'),
      file('c', 'routes/c.ts', 'routes'),
    ];
    expect(childTypeCounts(nodes, NOTHING_HIDDEN).get('routes')?.[0].type.label).toBe('Python');
  });

  it('counts all the way down, not just the folder\'s own children', () => {
    // The repo holds no files itself — only a folder that holds them.
    const nodes = [
      dir('repo', null),
      dir('src', 'repo'),
      file('a', 'src/a.ts', 'src'),
      file('b', 'src/b.ts', 'src'),
    ];
    const ranked = childTypeCounts(nodes, NOTHING_HIDDEN);
    expect(ranked.get('src')?.[0].type.label).toBe('TypeScript');
    expect(ranked.get('repo')?.[0]).toEqual({ type: expect.objectContaining({ label: 'TypeScript' }), count: 2 });
  });

  it('describes only what is still on screen when files are hidden', () => {
    const nodes = [
      dir('mixed', null),
      file('a', 'mixed/a.py', 'mixed'),
      file('b', 'mixed/b.py', 'mixed'),
      file('c', 'mixed/c.ts', 'mixed'),
    ];
    // With the Python pair filtered out, the folder is a TypeScript folder.
    const hidden = new Set(['a', 'b']);
    expect(childTypeCounts(nodes, hidden).get('mixed')?.[0].type.label).toBe('TypeScript');
  });

  it('leaves out a folder whose files are all hidden', () => {
    const nodes = [dir('empty', null), file('a', 'empty/a.py', 'empty')];
    expect(childTypeCounts(nodes, new Set(['a'])).has('empty')).toBe(false);
  });

  it('never lets Other win while a real language is in the folder', () => {
    const nodes = [
      dir('assets', null),
      file('a', 'assets/one.heic', 'assets'),
      file('b', 'assets/two.heic', 'assets'),
      file('c', 'assets/three.heic', 'assets'),
      file('d', 'assets/build.py', 'assets'),
    ];
    expect(childTypeCounts(nodes, NOTHING_HIDDEN).get('assets')?.[0].type.label).toBe('Python');
  });

  it('falls back to Other when there is nothing else to say', () => {
    const nodes = [
      dir('photos', null),
      file('a', 'photos/one.heic', 'photos'),
      file('b', 'photos/two.heic', 'photos'),
    ];
    expect(childTypeCounts(nodes, NOTHING_HIDDEN).get('photos')?.[0].type.label).toBe('Other');
  });

  it('settles a tie the same way every time, so a folder cannot flicker', () => {
    const nodes = [
      dir('even', null),
      file('a', 'even/a.py', 'even'),
      file('b', 'even/b.ts', 'even'),
    ];
    const first = childTypeCounts(nodes, NOTHING_HIDDEN).get('even')?.[0].type.label;
    const reversed = [nodes[0], nodes[2], nodes[1]];
    expect(childTypeCounts(reversed, NOTHING_HIDDEN).get('even')?.[0].type.label).toBe(first);
    expect(first).toBe('Python'); // alphabetically first of the tied pair
  });

  it('counts every type, in proportion — these become the outline\'s shares', () => {
    const nodes = [
      dir('mixed', null),
      file('a', 'mixed/a.py', 'mixed'),
      file('b', 'mixed/b.py', 'mixed'),
      file('c', 'mixed/c.py', 'mixed'),
      file('d', 'mixed/d.ts', 'mixed'),
    ];
    const shares = childTypeCounts(nodes, NOTHING_HIDDEN).get('mixed') ?? [];
    expect(shares.map((s) => [s.type.label, s.count])).toEqual([
      ['Python', 3],
      ['TypeScript', 1],
    ]);
  });

  it('ignores the pond tile and the table shelves, which have no file type', () => {
    const pond: TerrainNode = {
      ...file('pond', 'journal', 'repo'),
      file: { path: 'journal', touches: [], sessions: [], days: [] },
    };
    const nodes = [dir('repo', null), pond, file('a', 'repo/a.py', 'repo')];
    expect(childTypeCounts(nodes, NOTHING_HIDDEN).get('repo')?.[0].type.label).toBe('Python');
  });
});

/** Every file equally alive, for the cases where aliveness isn't the point. */
const ALL_ALIVE = () => 1;

describe('liveliestBeneath', () => {
  it('keeps a branch lit for its liveliest file, not its average one', () => {
    const nodes = [
      dir('mostly-dead', null),
      file('a', 'mostly-dead/a.py', 'mostly-dead'),
      file('b', 'mostly-dead/b.py', 'mostly-dead'),
      file('c', 'mostly-dead/c.py', 'mostly-dead'),
      file('fresh', 'mostly-dead/fresh.py', 'mostly-dead'),
    ];
    const alive = (node: TerrainNode) => (node.id === 'fresh' ? 0.9 : 0);
    expect(liveliestBeneath(nodes, NOTHING_HIDDEN, alive).get('mostly-dead')).toBe(0.9);
  });

  it('carries the liveliest file all the way up the tree', () => {
    const nodes = [
      dir('repo', null),
      dir('src', 'repo'),
      dir('deep', 'src'),
      file('a', 'src/deep/a.ts', 'deep'),
    ];
    const alive = () => 0.6;
    const liveliest = liveliestBeneath(nodes, NOTHING_HIDDEN, alive);
    expect(liveliest.get('deep')).toBe(0.6);
    expect(liveliest.get('src')).toBe(0.6);
    expect(liveliest.get('repo')).toBe(0.6);
  });

  it('goes dark when every file beneath it is dead', () => {
    const nodes = [dir('cold', null), file('a', 'cold/a.py', 'cold')];
    expect(liveliestBeneath(nodes, NOTHING_HIDDEN, () => 0).get('cold')).toBe(0);
  });

  it('does not count a file the activity switch has hidden', () => {
    const nodes = [
      dir('filtered', null),
      file('a', 'filtered/a.py', 'filtered'),
      file('b', 'filtered/b.py', 'filtered'),
    ];
    const alive = (node: TerrainNode) => (node.id === 'a' ? 1 : 0.2);
    expect(liveliestBeneath(nodes, new Set(['a']), alive).get('filtered')).toBe(0.2);
  });

  it('leaves out a folder with nothing visible in it, which reads as gone', () => {
    const nodes = [dir('empty', null), file('a', 'empty/a.py', 'empty')];
    const liveliest = liveliestBeneath(nodes, new Set(['a']), ALL_ALIVE);
    expect(liveliest.has('empty')).toBe(false);
    expect(liveliest.get('empty') ?? 0).toBe(0);
  });

  it('ignores the pond tile and the table shelves', () => {
    const pond: TerrainNode = {
      ...file('pond', 'journal', 'repo'),
      file: { path: 'journal', touches: [], sessions: [], days: [] },
    };
    const nodes = [dir('repo', null), pond];
    expect(liveliestBeneath(nodes, NOTHING_HIDDEN, ALL_ALIVE).has('repo')).toBe(false);
  });
});
