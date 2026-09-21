import { describe, expect, it } from 'vitest';
import { homeChain, tapStage, wiringTarget } from './hoverSelection';

/**
 * hoverSelection.test.ts — that the first click never opens anything and the
 * second click on the same body does; that a hover only counts inside what's
 * picked out (a pin holds against any cursor, a spotlight narrows onto its
 * own members and ignores everything else); and that a file's home chain
 * climbs to the repo without a malformed tree hanging the walk.
 */

describe('tapStage', () => {
  it('picks out a body nothing is holding yet', () => {
    expect(tapStage('vault:file:data/exo.db/todos', null)).toBe('pick');
  });

  it('opens the body that is already picked out', () => {
    expect(tapStage('agent-a', 'agent-a')).toBe('open');
  });

  it('moves the pick rather than opening, on a different body', () => {
    expect(tapStage('agent-b', 'agent-a')).toBe('pick');
  });
});

describe('wiringTarget', () => {
  // A spotlit agent: its orb and the three files it has touched.
  const footprint = new Set(['agent-a', 'store.py', 'server.py', 'todos.py']);
  const inFootprint = (id: string) => footprint.has(id);

  it('follows the cursor when nothing is picked out', () => {
    expect(wiringTarget('store.py', null, null)).toBe('store.py');
  });

  it('lights nothing when neither the cursor nor a pin has anything', () => {
    expect(wiringTarget(null, null, null)).toBeNull();
  });

  it('narrows onto one of the spotlit files', () => {
    expect(wiringTarget('server.py', null, inFootprint)).toBe('server.py');
  });

  it('ignores a hover outside the spotlight, leaving it lit', () => {
    expect(wiringTarget('elsewhere.py', null, inFootprint)).toBeNull();
  });

  it('keeps the pin while the cursor is on one of its own rope-ends', () => {
    expect(wiringTarget('store.py', 'table', null)).toBe('table');
  });

  it('keeps the pin while the cursor is somewhere else entirely', () => {
    expect(wiringTarget('elsewhere.py', 'table', null)).toBe('table');
  });

  it('keeps the pin with the cursor off the map', () => {
    expect(wiringTarget(null, 'table', null)).toBe('table');
  });

  it('lets the pin outrank a spotlight that is also up', () => {
    expect(wiringTarget('server.py', 'table', inFootprint)).toBe('table');
  });
});

describe('homeChain', () => {
  // A file three folders deep in one repo, the way the graph builds it.
  const tree: Record<string, string | null> = {
    'skeleton:file:frontend/src/main.tsx': 'skeleton:dir:frontend/src',
    'skeleton:dir:frontend/src': 'skeleton:dir:frontend',
    'skeleton:dir:frontend': 'skeleton',
    skeleton: null,
  };
  const parentOf = (id: string) => tree[id] ?? null;

  it('climbs from a file to its repo, nearest folder first', () => {
    expect(homeChain('skeleton:file:frontend/src/main.tsx', parentOf)).toEqual([
      'skeleton:dir:frontend/src',
      'skeleton:dir:frontend',
      'skeleton',
    ]);
  });

  it('gives a repo at the top of the tree nothing to light', () => {
    expect(homeChain('skeleton', parentOf)).toEqual([]);
  });

  it('gives an id the tree has never heard of nothing to light', () => {
    expect(homeChain('agent-a', parentOf)).toEqual([]);
  });

  it('ends the walk on a tree that points back at itself', () => {
    const loop: Record<string, string> = { a: 'b', b: 'c', c: 'a' };
    expect(homeChain('a', (id) => loop[id] ?? null)).toEqual(['b', 'c']);
  });
});
