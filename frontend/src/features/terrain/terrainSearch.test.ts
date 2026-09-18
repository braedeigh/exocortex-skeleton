import { describe, expect, it } from 'vitest';
import type { TerrainData } from './api';
import { POND_TILE_PATH } from './pondNodes';
import { searchTerrainFiles } from './terrainSearch';

/** A payload with just enough shape for the search: two repos, a handful of
 * files with touch stamps so recency ordering is testable. */
function payload(): TerrainData {
  const file = (path: string, last: number) => ({ path, touches: [last], sessions: [] });
  return {
    generated_at: '2026-09-17T00:00:00Z',
    repos: [
      {
        id: 'skeleton',
        name: 'Skeleton',
        root: '/s',
        files_total: 4,
        files: [
          file('routes/terrain.py', 100),
          file('routes/search_index.py', 300),
          file('frontend/src/features/terrain/terrainSearch.ts', 200),
          file('scripts/searcher.py', 400),
        ],
      },
      {
        id: 'vault',
        name: 'Vault',
        root: '/v',
        files_total: 2,
        files: [file('docs/search-notes.md', 50), file(POND_TILE_PATH, 999)],
      },
    ],
  } as unknown as TerrainData;
}

describe('searchTerrainFiles', () => {
  it('returns nothing for a blank query', () => {
    expect(searchTerrainFiles(payload(), '   ')).toEqual([]);
  });

  it('ranks filename-start over filename-contains over path-only, then by recency', () => {
    const ids = searchTerrainFiles(payload(), 'search').map((h) => h.path);
    expect(ids).toEqual([
      'scripts/searcher.py', // name starts with it, newest
      'routes/search_index.py', // name starts with it, older
      'docs/search-notes.md', // name starts with it, oldest
      'frontend/src/features/terrain/terrainSearch.ts', // name contains it
    ]);
  });

  it('matches case-insensitively and bolds the span inside the filename', () => {
    const [hit] = searchTerrainFiles(payload(), 'TERRAINsearch');
    expect(hit.name).toBe('terrainSearch.ts');
    expect(hit.path.slice(hit.start, hit.end)).toBe('terrainSearch');
  });

  it('matches directory segments when the filename does not match', () => {
    const hits = searchTerrainFiles(payload(), 'routes/');
    expect(hits.map((h) => h.path).sort()).toEqual(['routes/search_index.py', 'routes/terrain.py']);
    expect(hits[0].path.slice(hits[0].start, hits[0].end)).toBe('routes/');
  });

  it('skips hidden repos and never offers the pond tile', () => {
    expect(searchTerrainFiles(payload(), 'pond')).toEqual([]);
    const hits = searchTerrainFiles(payload(), 'search', { hiddenRepos: new Set(['vault']) });
    expect(hits.every((h) => h.repoId === 'skeleton')).toBe(true);
  });

  it('spells node ids the way the map does', () => {
    const [hit] = searchTerrainFiles(payload(), 'terrain.py');
    expect(hit.id).toBe('skeleton:file:routes/terrain.py');
  });
});
