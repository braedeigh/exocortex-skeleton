import { describe, expect, it } from 'vitest';
import { codeFileNode, searchWithCodeFile, searchWithoutCodeFile, type CodeFileSearch } from './codeFileSearch';
import type { TerrainNode } from './terrainGraph';

/** The map's whole search: the open file, plus the params that aren't about it. */
type MapSearch = CodeFileSearch & { journey?: string; embed?: boolean };

describe('searchWithCodeFile', () => {
  it('adds the file and keeps the params that were already there', () => {
    expect(searchWithCodeFile<MapSearch>({ journey: 'j1' }, 'skeleton', 'routes/spa.py')).toEqual({
      journey: 'j1',
      repo: 'skeleton',
      file: 'routes/spa.py',
    });
  });
  it('carries mentions when the file was opened from a table', () => {
    expect(searchWithCodeFile({}, 'skeleton', 'store.py', { label: 'todos', lines: [4, 9] })).toEqual({
      repo: 'skeleton',
      file: 'store.py',
      mentions: '4,9',
      of: 'todos',
    });
  });
  it('does not let a plain file inherit the last file’s mentions', () => {
    const before = { repo: 'skeleton', file: 'store.py', mentions: '4,9', of: 'todos' };
    expect(searchWithCodeFile(before, 'vault', 'notes.md')).toEqual({ repo: 'vault', file: 'notes.md' });
  });
});

describe('searchWithoutCodeFile', () => {
  it('removes the file and its mentions, and nothing else', () => {
    const before: MapSearch = { journey: 'j1', embed: true, repo: 'skeleton', file: 'store.py', mentions: '4', of: 'todos' };
    expect(searchWithoutCodeFile(before)).toEqual({ journey: 'j1', embed: true });
  });
});

describe('codeFileNode', () => {
  const onMap = { id: 'skeleton:file:store.py', kind: 'file', label: 'store.py', path: 'store.py', repoId: 'skeleton' } as TerrainNode;

  it('is null when the address names no file', () => {
    expect(codeFileNode(undefined, undefined, [onMap])).toBeNull();
    expect(codeFileNode('skeleton', undefined, [onMap])).toBeNull();
  });
  it('returns the map’s own node when the file is on the map', () => {
    expect(codeFileNode('skeleton', 'store.py', [onMap])).toBe(onMap);
  });
  it('stands in a bare node when the file is off the map or the map hasn’t loaded', () => {
    const node = codeFileNode('vault', 'docs/deep/notes.md', undefined);
    expect(node).toMatchObject({ id: 'vault:file:docs/deep/notes.md', repoId: 'vault', path: 'docs/deep/notes.md', label: 'notes.md' });
  });
});
