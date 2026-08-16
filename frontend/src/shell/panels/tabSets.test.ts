import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETS,
  createSet,
  isPinned,
  isTabSetList,
  pin,
  removeSet,
  removedBuiltIns,
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

describe('making a set', () => {
  it('adds an empty one on the end, leaving the others alone', () => {
    const next = createSet(sets(), 'set-x', 'Set 3');
    expect(next.map((s) => s.id)).toEqual(['work', 'life', 'set-x']);
    expect(next[2].sections).toEqual([]);
    expect(next.slice(0, 2)).toEqual(sets());
  });

  it('refuses an id already in use, which would make every lookup ambiguous', () => {
    const before = sets();
    expect(createSet(before, 'work', 'Set 3')).toBe(before);
  });

  it('refuses a blank id', () => {
    const before = sets();
    expect(createSet(before, '', 'Set 3')).toBe(before);
  });
});

describe('unmaking a set', () => {
  it('removes the one it names', () => {
    expect(removeSet(sets(), 'work').map((s) => s.id)).toEqual(['life']);
  });

  it('refuses the last one — no sets means no bar and no menu to rebuild from', () => {
    const one: TabSet[] = [{ id: 'work', name: 'Work', sections: ['journal'] }];
    expect(removeSet(one, 'work')).toBe(one);
  });

  it('removing something absent changes nothing', () => {
    const before = sets();
    expect(removeSet(before, 'nope')).toBe(before);
  });
});

describe('telling the server what is deleted', () => {
  // The server seeds back any built-in it is not told is gone, so this is the
  // whole of the record — and it is read off the list rather than tracked, so
  // there is no second copy to drift.
  it('names the built-ins that are missing', () => {
    expect(removedBuiltIns(sets())).toEqual(['spare']);
  });

  it('says nothing is deleted when they are all there', () => {
    expect(removedBuiltIns(DEFAULT_SETS)).toEqual([]);
  });

  it('ignores sets she made herself — nothing seeds those back', () => {
    const mine = [...DEFAULT_SETS, { id: 'set-x', name: 'Set 4', sections: [] }];
    expect(removedBuiltIns(mine)).toEqual([]);
    expect(removedBuiltIns(removeSet(mine, 'set-x'))).toEqual([]);
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
  it('seeds the two sets she asked for, plus an empty third', () => {
    expect(DEFAULT_SETS.map((s) => s.name)).toEqual(['Work', 'Life', 'Spare']);
    expect(DEFAULT_SETS[0].sections).toEqual(['observatory']);
    expect(DEFAULT_SETS[1].sections).toEqual(['journal', 'dashboard', 'pond']);
    expect(DEFAULT_SETS[2].sections).toEqual([]);
  });

  it('an empty set is a legitimate set, not a broken one', () => {
    // The bar has to survive being switched to a set with nothing in it.
    expect(isTabSetList(DEFAULT_SETS)).toBe(true);
    expect(sectionsOf(DEFAULT_SETS, 'spare')).toEqual([]);
  });

  it('every seeded id is a real section', () => {
    for (const set of DEFAULT_SETS) {
      expect(sectionsOf(DEFAULT_SETS, set.id)).toHaveLength(set.sections.length);
    }
  });
});
