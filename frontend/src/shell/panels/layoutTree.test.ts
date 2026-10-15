import { describe, expect, it } from 'vitest';
import {
  MIN_PCT,
  canClosePanel,
  closePanel,
  findPanel,
  isLayoutNode,
  listPanels,
  moveTabToPanel,
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

describe('closing either side, the primary included', () => {
  const withTabs = (): LayoutNode => ({
    type: 'split',
    id: 's1',
    dir: 'row',
    sizes: [50, 50],
    children: [
      { type: 'panel', id: 'left', kind: 'route', url: '/observatory/session?conv=c1', setId: 'work',
        tabs: [{ url: '/observatory/session?conv=c1', at: 1 }] },
      { type: 'panel', id: 'right', kind: 'primary', setId: 'life', tabs: [{ url: '/code?path=a.py', at: 1 }] },
    ],
  });

  it('closing the primary hands the job to the other side, which keeps its tabs and set', () => {
    const next = closePanel(withTabs(), 'right');
    expect(next).toEqual({
      type: 'panel',
      id: 'left',
      kind: 'primary',
      setId: 'work',
      tabs: [{ url: '/observatory/session?conv=c1', at: 1 }],
    });
  });

  it('always leaves exactly one primary, whichever panel of many is closed', () => {
    let tree: LayoutNode = splitPanel(withTabs(), 'right', 'col', panel('below'), 's2');
    tree = splitPanel(tree, 'left', 'row', panel('beside'), 's3');
    for (const id of ['right', 'left', 'beside']) {
      tree = closePanel(tree, id);
      expect(listPanels(tree).filter((p) => p.kind === 'primary')).toHaveLength(1);
    }
    expect(listPanels(tree).map((p) => p.id)).toEqual(['below']);
  });

  it('the heir is the neighbour that grows into the closed space', () => {
    const three: LayoutNode = {
      type: 'split', id: 's', dir: 'row', sizes: [34, 33, 33],
      children: [panel('a'), panel('p', 'primary'), panel('b')],
    };
    const next = closePanel(three, 'p');
    expect(findPanel(next, 'b')?.kind).toBe('primary');
    expect(findPanel(next, 'a')?.kind).toBe('route');
  });

  it('a route panel without a set keeps wearing the one it wore', () => {
    const tree: LayoutNode = { type: 'split', id: 's', dir: 'row', sizes: [50, 50],
      children: [panel('a', 'route', '/code'), panel('p', 'primary')] };
    expect((closePanel(tree, 'p') as PanelNode).setId).toBe('work');
  });

  it('the last panel has no close, and a primary beside only a reading room stays', () => {
    expect(canClosePanel(panel('p', 'primary'), 'p')).toBe(false);
    const legacy = twoUp(); // the reading room beside the primary
    expect(canClosePanel(legacy, 'p-main')).toBe(false);
    expect(closePanel(legacy, 'p-main')).toBe(legacy);
    expect(canClosePanel(legacy, 'p-pane')).toBe(true);
    expect(canClosePanel(withTabs(), 'right')).toBe(true);
  });
});

describe('dragging a tab to another panel', () => {
  const conv = (id: string) => `/observatory/session?conv=${id}`;
  const tree = (): LayoutNode => ({
    type: 'split', id: 's', dir: 'row', sizes: [50, 50],
    children: [
      { type: 'panel', id: 'L', kind: 'route', url: conv('a'),
        tabs: [{ url: conv('a'), at: 1 }, { url: conv('b'), at: 2 }] },
      { type: 'panel', id: 'R', kind: 'primary', tabs: [{ url: '/x', at: 1 }, { url: '/y', at: 1 }] },
    ],
  });
  const tabsOf = (t: LayoutNode, id: string) => (findPanel(t, id)?.tabs ?? []).map((x) => x.url);

  it('leaves one row and joins the other at the gap it was dropped in', () => {
    const next = moveTabToPanel(tree(), 'L', 'R', conv('a'), 1);
    expect(tabsOf(next, 'L')).toEqual([conv('b')]);
    expect(tabsOf(next, 'R')).toEqual(['/x', conv('a'), '/y']);
  });

  it('never leaves one conversation open in two rows, even if the target had it', () => {
    let t = tree();
    t = moveTabToPanel(t, 'L', 'R', conv('b'), 0);
    // And back, then across again: still exactly one copy in the whole window.
    t = moveTabToPanel(t, 'R', 'L', conv('b'), 2);
    t = moveTabToPanel(t, 'L', 'R', conv('b'), 9);
    const all = listPanels(t).flatMap((p) => (p.tabs ?? []).map((x) => x.url));
    expect(all.filter((u) => u === conv('b'))).toHaveLength(1);
    expect(tabsOf(t, 'R')).toEqual(['/x', '/y', conv('b')]);

    const dup = tree();
    const R = findPanel(dup, 'R')!;
    R.tabs = [...(R.tabs ?? []), { url: conv('a'), at: 9 }];
    const merged = moveTabToPanel(dup, 'L', 'R', conv('a'), 0);
    expect(tabsOf(merged, 'R')).toEqual(['/x', '/y', conv('a')]);
    expect(tabsOf(merged, 'L')).toEqual([conv('b')]);
  });

  it('a drop that moves nothing returns the same tree', () => {
    const t = tree();
    expect(moveTabToPanel(t, 'L', 'L', conv('a'), 0)).toBe(t);
    expect(moveTabToPanel(t, 'L', 'R', '/not-open', 0)).toBe(t);
    expect(moveTabToPanel(t, 'L', 'nope', conv('a'), 0)).toBe(t);
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
