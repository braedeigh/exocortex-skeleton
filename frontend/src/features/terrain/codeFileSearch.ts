import { mentionsToSearch, type CodeMentions } from './codeMentions';
import type { TerrainNode } from './terrainGraph';

/**
 * codeFileSearch.ts — the file open over the Terrain map, spelled as part of
 * the map's address:
 *
 *   /terrain/map?repo=skeleton&file=routes/spa.py&mentions=4,9&of=todos
 *
 * WHY THE OPEN FILE LIVES IN THE ADDRESS. When it was only held in the page's
 * memory, a refresh forgot it and dropped her back on the bare map, and the
 * browser had nothing to go "back" from. In the address, a refresh reopens
 * the same file, and opening a file is a real step in the browser's history —
 * so the pane's ×, Esc, the browser's back button and a swipe-back are all the
 * same move: back to wherever she opened it from.
 *
 * This file is only the spelling — pure functions, no React. TerrainPage.tsx
 * reads and writes the address with them; routes/terrain_.map.tsx keeps the
 * params in its search schema so the router doesn't strip them. The mentions
 * params are spelled by codeMentions.ts, the same as on /code.
 *
 * Her ask: "if I refresh it I want for the code to stay there rather than
 * refreshing to terrain", and "the x is fine if it's functionally the same as
 * a back button."
 */

/** The map's search params that, together, mean "this file is open". */
export interface CodeFileSearch {
  /** Terrain repo id the file is in — 'skeleton' | 'vault'. */
  repo?: string;
  /** Repo-relative path of the open file. */
  file?: string;
  /** Lines that name the table she came from (codeMentions.ts). */
  mentions?: string;
  /** That table's name. */
  of?: string;
}

/** Add an open file to the map's search params. Any file already in them is
 * replaced whole, mentions included — a file opened from a plain dot must not
 * inherit the last file's mention strip. */
export function searchWithCodeFile<T extends CodeFileSearch>(
  previous: T,
  repo: string,
  path: string,
  mentions?: CodeMentions,
): T {
  return { ...searchWithoutCodeFile(previous), repo, file: path, ...mentionsToSearch(mentions) };
}

/** Take the open file back out of the map's search params, leaving every
 * other param (journey, embed) as it was. */
export function searchWithoutCodeFile<T extends CodeFileSearch>(previous: T): T {
  const next = { ...previous };
  delete next.repo;
  delete next.file;
  delete next.mentions;
  delete next.of;
  return next;
}

/**
 * Find the node for the file the address names — or stand one in.
 *
 * The pane shows what the MAP knows about the file (its touches, its agents),
 * so the real node is wanted when there is one. But the file may not be ON
 * the map: the Files dial cuts to the hottest few hundred, and right after a
 * refresh the map hasn't loaded at all. A bare stand-in node carries the repo
 * and path, which is all the pane needs to show the code.
 */
export function codeFileNode(
  repo: string | undefined,
  path: string | undefined,
  nodes: readonly TerrainNode[] | undefined,
): TerrainNode | null {
  if (!repo || !path) return null;
  const id = `${repo}:file:${path}`;
  return (
    nodes?.find((n) => n.id === id) ?? {
      id,
      kind: 'file',
      label: path.split('/').filter(Boolean).slice(-1)[0] ?? path,
      parentId: null,
      depth: 0,
      repoId: repo,
      path,
      heat: 0,
    }
  );
}
