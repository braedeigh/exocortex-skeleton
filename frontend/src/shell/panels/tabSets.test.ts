import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETS,
  isPinned,
  isTabSetList,
  pin,
  reorder,
  sectionsOf,
  unpin,
  type TabSet,
} from './tabSets';

const sets = (): TabSet[] => [
  { id: 'work', name: 'Work', sections: ['observatory', 'research', 'terrain'] },
  { id: 'life', name: 'Life', sections: ['journal', 'dashboard', 'pond'] },
];

describe('reading a set', () => {
  it('resolves ids to sections in the order they were pinned', () => {
    expect(sectionsOf(sets(), 'work').map((s) => s.label)).toEqual([
      'Observatory',
      'Research',
      'Terrain',
    ]);
  });

  it('drops an id no section answers to, keeping the rest of the bar', () => {
    const withGhost: TabSet[] = [{ id: 'work', name: 'Work', sections: ['journal', 'ghost', 'pond'] }];
    expect(sectionsOf(withGhost, 'work').map((s) => s.id)).toEqual(['journal', 'pond']);
  });

  it('has nothing to show for a set that is not there', () => {
    expect(sectionsOf(sets(), 'nope')).toEqual([]);
  });
});

describe('pinning', () => {
  it('adds to the end of the set it names, leaving the other alone', () => {
    const next = pin(sets(), 'work', 'journal');
    expect(next[0].sections).toEqual(['observatory', 'research', 'terrain', 'journal']);
    expect(next[1]).toEqual(sets()[1]);
  });

  it('is a no-op when already pinned, so the star is a clean toggle', () => {
    const before = sets();
    expect(pin(before, 'work', 'research')).toBe(before);
  });

  it('refuses an id no section answers to', () => {
    const before = sets();
    expect(pin(before, 'work', 'ghost')).toBe(before);
  });

  it('unpins, and reports what is pinned', () => {
    expect(isPinned(sets(), 'work', 'research')).toBe(true);
    const next = unpin(sets(), 'work', 'research');
    expect(next[0].sections).toEqual(['observatory', 'terrain']);
    expect(isPinned(next, 'work', 'research')).toBe(false);
  });

  it('unpinning something absent changes nothing', () => {
    const before = sets();
    expect(unpin(before, 'work', 'journal')).toBe(before);
  });

  it('lets a set be emptied completely', () => {
    let next = sets();
    for (const id of ['observatory', 'research', 'terrain']) next = unpin(next, 'work', id);
    expect(next[0].sections).toEqual([]);
  });
});

describe('reordering by drag', () => {
  it('moves a tab forward', () => {
    expect(reorder(sets(), 'work', 0, 2)[0].sections).toEqual(['research', 'terrain', 'observatory']);
  });

  it('moves a tab backward', () => {
    expect(reorder(sets(), 'work', 2, 0)[0].sections).toEqual(['terrain', 'observatory', 'research']);
  });

  it('leaves the bar alone for a drop that landed nowhere', () => {
    const before = sets();
    expect(reorder(before, 'work', 0, 0)).toBe(before);
    expect(reorder(before, 'work', -1, 1)).toBe(before);
    expect(reorder(before, 'work', 0, 9)).toBe(before);
    expect(reorder(before, 'nope', 0, 1)).toBe(before);
  });
});

describe('trusting what the server sent', () => {
  it('accepts the defaults and a real list', () => {
    expect(isTabSetList(DEFAULT_SETS)).toBe(true);
    expect(isTabSetList(sets())).toBe(true);
  });

  it('rejects junk, and an empty list that would leave her with no tabs', () => {
    expect(isTabSetList(null)).toBe(false);
    expect(isTabSetList([])).toBe(false);
    expect(isTabSetList([{ id: 'x', name: 'X' }])).toBe(false);
    expect(isTabSetList([{ id: 'x', name: 'X', sections: [1, 2] }])).toBe(false);
  });
});

describe('the defaults match the server', () => {
  it('seeds the two sets she asked for', () => {
    expect(DEFAULT_SETS.map((s) => s.name)).toEqual(['Work', 'Life']);
    expect(DEFAULT_SETS[0].sections).toEqual(['observatory', 'research', 'terrain']);
    expect(DEFAULT_SETS[1].sections).toEqual(['journal', 'dashboard', 'pond']);
  });

  it('every seeded id is a real section', () => {
    for (const set of DEFAULT_SETS) {
      expect(sectionsOf(DEFAULT_SETS, set.id)).toHaveLength(set.sections.length);
    }
  });
});
