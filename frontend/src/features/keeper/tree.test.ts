import { describe, expect, it } from 'vitest';
import {
  buildStemIndex,
  displayName,
  groupFiles,
  loadGroupOpen,
  matchesQuery,
  resolveStem,
  saveGroupOpen,
  sortGroupFiles,
  splitPath,
} from './tree';
import type { KeeperFile } from './types';

function f(path: string, group: string): KeeperFile {
  const name = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return { path, name, group, mtime: 0 };
}

describe('groupFiles', () => {
  it('orders known groups by GROUP_ORDER, unknown groups after, alphabetical', () => {
    const groups = groupFiles([
      f('zeta/a.md', 'zeta'),
      f('Patterns/x.md', 'Patterns'),
      f('about.md', 'Core'),
      f('meetings/m.md', 'meetings'),
      f('people/sage.md', 'people'),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Core', 'people', 'Patterns', 'meetings', 'zeta']);
  });

  it('keeps every file under its own group', () => {
    const groups = groupFiles([f('people/a.md', 'people'), f('people/b.md', 'people'), f('x.md', 'Core')]);
    expect(groups.find((g) => g.group === 'people')?.files).toHaveLength(2);
    expect(groups.find((g) => g.group === 'Core')?.files).toHaveLength(1);
  });
});

describe('sortGroupFiles', () => {
  it('sorts dated files newest-first (journal, diary)', () => {
    const sorted = sortGroupFiles([
      f('Journal/2026-01-02.md', 'Journal'),
      f('Journal/2026-03-01.md', 'Journal'),
      f('Journal/2025-12-31.md', 'Journal'),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(['2026-03-01', '2026-01-02', '2025-12-31']);
  });

  it('sorts undated files alphabetically', () => {
    const sorted = sortGroupFiles([f('people/zoe.md', 'people'), f('people/ann.md', 'people')]);
    expect(sorted.map((x) => x.name)).toEqual(['ann', 'zoe']);
  });
});

describe('buildStemIndex / resolveStem', () => {
  it('indexes lowercased stems to paths', () => {
    const idx = buildStemIndex([f('Patterns/Sleep.md', 'Patterns')]);
    expect(resolveStem(idx, 'sleep')).toBe('Patterns/Sleep.md');
  });

  it('lets a people/ file win a name collision, regardless of order', () => {
    const a = buildStemIndex([f('context/sage.md', 'context'), f('people/sage.md', 'people')]);
    expect(resolveStem(a, 'sage')).toBe('people/sage.md');
    const b = buildStemIndex([f('people/sage.md', 'people'), f('context/sage.md', 'context')]);
    expect(resolveStem(b, 'sage')).toBe('people/sage.md');
  });

  it('trims and lowercases the wikilink name when resolving', () => {
    const idx = buildStemIndex([f('people/sage.md', 'people')]);
    expect(resolveStem(idx, '  Sage ')).toBe('people/sage.md');
    expect(resolveStem(idx, 'nobody')).toBeUndefined();
  });
});

describe('matchesQuery', () => {
  const file = f('people/sage-jones.md', 'people');

  it('matches on the name, case-insensitive', () => {
    expect(matchesQuery(file, 'SAGE')).toBe(true);
  });

  it('matches on the path (directory part included)', () => {
    expect(matchesQuery(file, 'people/')).toBe(true);
  });

  it('rejects non-matches and accepts an empty/whitespace query', () => {
    expect(matchesQuery(file, 'kitchen')).toBe(false);
    expect(matchesQuery(file, '')).toBe(true);
    expect(matchesQuery(file, '   ')).toBe(true);
  });
});

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    dump: () => Object.fromEntries(m),
  };
}

describe('group open-state persistence (legacy localStorage keys)', () => {
  it('defaults Core/people/Patterns open, everything else closed', () => {
    const s = fakeStorage();
    expect(loadGroupOpen('Core', s)).toBe(true);
    expect(loadGroupOpen('people', s)).toBe(true);
    expect(loadGroupOpen('Patterns', s)).toBe(true);
    expect(loadGroupOpen('Journal', s)).toBe(false);
  });

  it('honors a remembered value over the default', () => {
    const s = fakeStorage({ 'keeper.open.Core': '0', 'keeper.open.Journal': '1' });
    expect(loadGroupOpen('Core', s)).toBe(false);
    expect(loadGroupOpen('Journal', s)).toBe(true);
  });

  it('writes the exact legacy key format (keeper.open.<group> = 1/0)', () => {
    const s = fakeStorage();
    saveGroupOpen('people', true, s);
    saveGroupOpen('Journal', false, s);
    expect(s.dump()).toEqual({ 'keeper.open.people': '1', 'keeper.open.Journal': '0' });
  });
});

describe('path helpers', () => {
  it('splits dir (muted in the pane head) from base', () => {
    expect(splitPath('people/sage.md')).toEqual({ dir: 'people/', base: 'sage.md' });
    expect(splitPath('about.md')).toEqual({ dir: '', base: 'about.md' });
  });

  it('derives the undo-toast display name', () => {
    expect(displayName('people/sage.md')).toBe('sage');
    expect(displayName('about.md')).toBe('about');
  });
});
