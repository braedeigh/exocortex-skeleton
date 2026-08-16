import { describe, expect, it } from 'vitest';
import {
  MIN_PCT,
  closePanel,
  findPanel,
  isLayoutNode,
  listPanels,
  parentOf,
  resizeSplit,
  setPanelUrl,
  splitPanel,
  type LayoutNode,
  type PanelNode,
} from './layoutTree';

const panel = (id: string, kind: PanelNode['kind'] = 'route', url?: string): PanelNode => ({
  type: 'panel',
  id,
  kind,
  ...(url ? { url } : {}),
});

/** The default arrangement: the reading room beside the routed content. */
const twoUp = (): LayoutNode => ({
  type: 'split',
  id: 's1',
  dir: 'row',
  sizes: [50, 50],
  children: [panel('p-pane', 'pane'), panel('p-main', 'primary')],
});

describe('reading the tree', () => {
  it('lists panels left to right', () => {
    expect(listPanels(twoUp()).map((p) => p.id)).toEqual(['p-pane', 'p-main']);
  });

  it('finds a panel nested inside a split', () => {
    const nested = splitPanel(twoUp(), 'p-main', 'col', panel('p-new'), 's2');
    expect(findPanel(nested, 'p-new')?.id).toBe('p-new');
    expect(parentOf(nested, 'p-new')?.id).toBe('s2');
  });
});

describe('splitting', () => {
  it('splits a panel in the other direction by nesting a new split', () => {
    const next = splitPanel(twoUp(), 'p-main', 'col', panel('p-new'), 's2');
    const root = next as Extract<LayoutNode, { type: 'split' }>;
    const right = root.children[1] as Extract<LayoutNode, { type: 'split' }>;
    expect(right.type).toBe('split');
    expect(right.dir).toBe('col');
    expect(right.children.map((c) => c.id)).toEqual(['p-main', 'p-new']);
    // The rest of the layout is untouched — the left half is still half.
    expect(root.sizes).toEqual([50, 50]);
  });

  it('splits in the SAME direction as a sibling instead of nesting', () => {
    // Splitting right twice should give three even-ish columns, not a
    // staircase of nested pairs.
    const once = splitPanel(twoUp(), 'p-main', 'row', panel('a'), 's2');
    const twice = splitPanel(once, 'a', 'row', panel('b'), 's3');
    const root = twice as Extract<LayoutNode, { type: 'split' }>;
    expect(root.id).toBe('s1');
    expect(root.children.map((c) => c.id)).toEqual(['p-pane', 'p-main', 'a', 'b']);
    expect(root.children.every((c) => c.type === 'panel')).toBe(true);
  });

  it('takes the new panel space from its sibling only', () => {
    const next = splitPanel(twoUp(), 'p-main', 'row', panel('a'), 's2') as Extract<
      LayoutNode,
      { type: 'split' }
    >;
    expect(next.sizes).toEqual([50, 25, 25]);
  });

  it('ignores a split of a panel that is not there', () => {
    const tree = twoUp();
    expect(splitPanel(tree, 'nope', 'row', panel('a'), 's2')).toBe(tree);
  });
});

describe('closing', () => {
  it('collapses a split of one back into a plain panel', () => {
    const next = closePanel(twoUp(), 'p-pane');
    expect(next.type).toBe('panel');
    expect((next as PanelNode).id).toBe('p-main');
  });

  it('keeps the remaining siblings when a split had three children', () => {
    const three = splitPanel(twoUp(), 'p-main', 'row', panel('a'), 's2');
    const next = closePanel(three, 'a') as Extract<LayoutNode, { type: 'split' }>;
    expect(next.children.map((c) => c.id)).toEqual(['p-pane', 'p-main']);
    // Sizes are rescaled back to a full 100 rather than leaving a gap.
    expect(next.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it('refuses to close the last panel standing', () => {
    const lone = panel('p-main', 'primary');
    expect(closePanel(lone, 'p-main')).toBe(lone);
  });

  it('is a no-op for an id that is not in the tree', () => {
    const tree = twoUp();
    expect(closePanel(tree, 'nope')).toBe(tree);
  });
});

describe('resizing', () => {
  it('moves space from one side of a boundary to the other', () => {
    const next = resizeSplit(twoUp(), 's1', 0, 10) as Extract<LayoutNode, { type: 'split' }>;
    expect(next.sizes).toEqual([60, 40]);
  });

  it('clamps so a panel can never be dragged away to nothing', () => {
    const next = resizeSplit(twoUp(), 's1', 0, 999) as Extract<LayoutNode, { type: 'split' }>;
    expect(next.sizes).toEqual([100 - MIN_PCT, MIN_PCT]);
  });

  it('clamps the same way dragging the other direction', () => {
    const next = resizeSplit(twoUp(), 's1', 0, -999) as Extract<LayoutNode, { type: 'split' }>;
    expect(next.sizes).toEqual([MIN_PCT, 100 - MIN_PCT]);
  });

  it('leaves other children of a three-way split alone', () => {
    const three = splitPanel(twoUp(), 'p-main', 'row', panel('a'), 's2');
    const next = resizeSplit(three, 's1', 1, 5) as Extract<LayoutNode, { type: 'split' }>;
    expect(next.sizes[0]).toBe(50);
    expect(next.sizes[1]).toBe(30);
    expect(next.sizes[2]).toBe(20);
  });

  it('returns the same tree when nothing moves', () => {
    const tree = twoUp();
    expect(resizeSplit(tree, 's1', 0, 0)).toBe(tree);
    expect(resizeSplit(tree, 'nope', 0, 10)).toBe(tree);
  });
});

describe('pointing a panel somewhere', () => {
  it('sets a url and returns the same tree when unchanged', () => {
    const next = setPanelUrl(twoUp(), 'p-main', '/code?repo=skeleton');
    expect(findPanel(next, 'p-main')?.url).toBe('/code?repo=skeleton');
    expect(setPanelUrl(next, 'p-main', '/code?repo=skeleton')).toBe(next);
  });
});

describe('trusting what came out of storage', () => {
  it('accepts a real tree', () => {
    expect(isLayoutNode(twoUp())).toBe(true);
  });

  it('rejects junk, wrong kinds, and malformed splits', () => {
    expect(isLayoutNode(null)).toBe(false);
    expect(isLayoutNode({ type: 'panel', id: 'x', kind: 'wat' })).toBe(false);
    expect(isLayoutNode({ type: 'split', id: 's', dir: 'row', sizes: [100], children: [panel('a')] })).toBe(
      false,
    );
    // sizes and children out of step
    expect(
      isLayoutNode({ type: 'split', id: 's', dir: 'row', sizes: [50], children: [panel('a'), panel('b')] }),
    ).toBe(false);
  });
});
