/**
 * terrainSearch.ts — the file search behind the Terrain page's search field.
 * Pure matching and ranking, no React: give it the terrain payload and what
 * she typed, get back the files that match, best first, each with the span
 * of the path that matched so the list can bold it.
 *
 * It runs over the PAYLOAD, not over the drawn nodes — the Files dial may
 * have cut a file the search should still find. TerrainPage pins every hit
 * through filterTerrainData (the same pin the journey replay uses), so a
 * found file is always drawn, and then lights the hits with the same
 * spotlight an agent tap uses (everything else recedes, hits ring and
 * caption themselves).
 *
 * Ranking is three tiers, then recency: a filename that STARTS with the
 * query beats a filename that merely contains it, which beats a match
 * somewhere earlier in the path. Inside a tier the most recently touched
 * file wins — "the search.py I was just in" is the likelier ask.
 *
 * Prompt that produced it: "i want to do file search on the terrain
 * interface. i want to be able to search for a file and have it show files
 * lit up ... so i can click and open them from this interface."
 */
import type { TerrainData } from './api';
import { fileLastTouch } from './terrainGraph';
import { POND_TILE_PATH } from './pondNodes';

export interface TerrainSearchHit {
  /** The node id the map knows this file by (`${repo}:file:${path}`). */
  id: string;
  repoId: string;
  repoName: string;
  path: string;
  /** Final path segment — what the list shows big. */
  name: string;
  /** The matched span inside `path`, for bolding. */
  start: number;
  end: number;
}

/** How many hits the list shows. The map lights the same set; past this
 * the query is too loose to be a search and the list would be a scroll. */
export const SEARCH_HIT_CAP = 40;

/** How many hits the MAP captions. Every hit is lit and ringed; only the
 * best few get a name on the canvas, because the list already names them
 * all and a directory full of captions reads as soup. */
export const SEARCH_LABEL_CAP = 6;

/** The node id for a file — one place to spell it, matching terrainGraph. */
export function fileNodeId(repoId: string, path: string): string {
  return `${repoId}:file:${path}`;
}

export function searchTerrainFiles(
  data: TerrainData | null | undefined,
  rawQuery: string,
  opts: { hiddenRepos?: ReadonlySet<string>; cap?: number } = {},
): TerrainSearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query || !data) return [];
  const cap = opts.cap ?? SEARCH_HIT_CAP;

  interface Scored { hit: TerrainSearchHit; tier: number; last: number }
  const scored: Scored[] = [];

  for (const repo of data.repos) {
    if (opts.hiddenRepos?.has(repo.id)) continue;
    for (const file of repo.files) {
      // The pond tile is a synthetic month of journal, not a file to open.
      if (file.path === POND_TILE_PATH) continue;
      const path = file.path;
      const lower = path.toLowerCase();
      const at = lower.indexOf(query);
      if (at < 0) continue;
      const slash = path.lastIndexOf('/');
      const nameStart = slash + 1;
      const name = path.slice(nameStart);
      // Prefer the match in the filename when the query occurs in both the
      // directory and the name — bold the one she most likely meant.
      const inName = lower.indexOf(query, nameStart);
      const matchAt = inName >= 0 ? inName : at;
      const tier = inName === nameStart ? 0 : inName >= 0 ? 1 : 2;
      scored.push({
        hit: {
          id: fileNodeId(repo.id, path),
          repoId: repo.id,
          repoName: repo.name,
          path,
          name,
          start: matchAt,
          end: matchAt + query.length,
        },
        tier,
        last: fileLastTouch(file) ?? 0,
      });
    }
  }

  scored.sort((a, b) => a.tier - b.tier || b.last - a.last || a.hit.path.localeCompare(b.hit.path));
  return scored.slice(0, cap).map((s) => s.hit);
}
