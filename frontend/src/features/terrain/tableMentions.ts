import type { TerrainTable, TerrainTables } from './api';
import { tableNodeId } from './tableNodes';

/**
 * tableMentions.ts — the wire between a SQL table and the code files that
 * touch it, in the two shapes the map needs it.
 *
 * The server already finds this: it searches the app's Python for SQL that
 * names each table and reports every file, every line
 * (routes/terrain_tables.py scan_code). What was missing was anywhere for
 * that answer to go except a list of filenames on a card. This file turns it
 * into two things:
 *
 *   LINES ON THE MAP   tableCodeLinks() pairs each table's node with the node
 *                      of each file that touches it, so hovering either end
 *                      can draw the ropes between them (terrainCanvas.ts
 *                      setTableCodeLinks). Only pairs where BOTH ends are
 *                      actually on the map survive — a file the Files dial cut
 *                      has no dot to draw to.
 *   MENTIONS IN A FILE fileMentions() merges one file's hits across creates,
 *                      writes and reads into one ascending list of line
 *                      numbers, which is what the open file highlights and
 *                      steps between (FileCodeBody's mention strip).
 *
 * Pure arithmetic over the payload — no fetch, no DOM — and tested in
 * tableMentions.test.ts. Read by TerrainPage.tsx (which owns both the graph
 * and the tables payload), TerrainTableSheet.tsx (the card's file buttons)
 * and terrainCanvas.ts.
 *
 * Prompt that produced it: "for my terrain map, i'm wanting to connect my sql
 * databases to files … when i hover over it to have lines pop up connecting
 * them to the files that created them and interact with them" / "when i click
 * those files in the popup for each data table, it highlights where the table
 * was mentioned in the code file when i open it up and i can hop between them
 * if there are multiple".
 */

/** What a file does to a table. Ordered weakest to strongest on purpose —
 * `VERB_RANK` below reads the order straight off this list. */
export const CODE_VERBS = ['reads', 'writes', 'creates'] as const;
export type CodeVerb = (typeof CODE_VERBS)[number];

/** How loudly each verb draws. A file that both reads and writes a table is
 * drawn as the strongest thing it does — one rope per pair, not three. */
const VERB_RANK: Record<CodeVerb, number> = {
  reads: 0,
  writes: 1,
  creates: 2,
};

/** One rope: a table's node, a code file's node, and what the file does. */
export interface TableCodeLink {
  tableId: string;
  fileId: string;
  verb: CodeVerb;
}

/**
 * Every line one file names one table on, ascending, with no repeats.
 *
 * Merges the three verb groups, because a file that both writes and reads a
 * table has its mentions spread across two of them and she is stepping
 * through ONE file. Falls back to the hit's `line` when the server predates
 * the full list — one mention is still a place to land.
 */
export function fileMentions(table: TerrainTable, path: string): number[] {
  const lines = new Set<number>();
  for (const verb of CODE_VERBS) {
    for (const hit of table.code?.[verb] ?? []) {
      if (hit.path !== path) continue;
      if (hit.lines && hit.lines.length > 0) for (const line of hit.lines) lines.add(line);
      else lines.add(hit.line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Pair every table with the files that touch it, as map node ids.
 *
 * Skips a pair whose file isn't on the map — the Files dial keeps only the
 * hottest few hundred dots, and a rope to a dot that isn't drawn would end in
 * empty space. The card still lists the file either way, which is where the
 * full answer lives; this is only what can be DRAWN.
 *
 * `known` is the set of node ids the graph actually built. Returns one link
 * per table/file pair, carrying the strongest verb that pair earned.
 */
export function tableCodeLinks(
  tables: TerrainTables | undefined,
  known: ReadonlySet<string>,
): TableCodeLink[] {
  if (!tables || tables.repo === null || tables.path === null) return [];
  const strongest = new Map<string, TableCodeLink>();
  for (const table of tables.tables) {
    const tableId = tableNodeId(tables.repo, tables.path, table.name);
    if (!known.has(tableId)) continue;
    for (const verb of CODE_VERBS) {
      for (const hit of table.code?.[verb] ?? []) {
        const fileId = `${tables.code_repo}:file:${hit.path}`;
        if (!known.has(fileId)) continue;
        const pair = `${tableId}\n${fileId}`;
        const held = strongest.get(pair);
        if (held === undefined || VERB_RANK[verb] > VERB_RANK[held.verb]) {
          strongest.set(pair, { tableId, fileId, verb });
        }
      }
    }
  }
  return [...strongest.values()];
}
