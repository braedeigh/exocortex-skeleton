/**
 * tableNodes.ts — the database's tables, put on the map as bodies you can read
 * the SHAPE of.
 *
 * THE PROBLEM THIS SOLVES. The map draws files, and the database is one
 * binary file, so everything she has stored was either absent or a single
 * anonymous dot. But a database has a shape of its own: some tables are wide
 * (many columns — one row describes a whole thing), some are tall (few
 * columns, many rows — a log, or a list of links), and they point at each
 * other through foreign keys. None of that is visible in a file listing.
 *
 * So each table becomes one synthetic file on the map, drawn as a RECTANGLE
 * that is literally the table's shape:
 *
 *   WIDTH   one stripe per column — a 22-column table is 22 stripes wide.
 *   HEIGHT  how many rows it holds, on a square-root scale (see ROW_SCALE for
 *           why not a straight line).
 *   LINES   a foreign key is drawn as a line from the table that holds the
 *           key to the table it points at.
 *
 * THE SHELVES. The tables don't float among the dots; they stand in a section
 * of their own beside the vault, arranged like books on shelves (shelfLayout,
 * below). Each shelf is a FAMILY — tables joined to each other by foreign
 * keys, read straight from the schema so it can't go stale — with a parent
 * table first and the tables that point at it after. Everything on a shelf
 * stands on one baseline, which is what makes heights comparable: on a shared
 * floor, taller really does mean more rows. Tables joined to nothing share a
 * last shelf.
 *
 * Tall and thin, wide and flat, big and small can then be told apart at a
 * glance, which is the point: learning what the tables ARE by looking.
 *
 * WHERE IT SITS. After the dials, before `buildTerrainGraph` — the same seam
 * pondNodes.ts uses, one step later. It returns a new TerrainData with one
 * extra file per table, pathed UNDER the database file's real path
 * (`data/exo.db/todos`), so the graph's folder logic makes an `exo.db` folder
 * where the database really lives and hangs the tables off it. After the
 * dials on purpose: the Files and date dials rank files by edit history, a
 * table has none, and a dial should not be able to delete the database from
 * the map.
 *
 * Everything in here is pure arithmetic and tested (tableNodes.test.ts). The
 * numbers come from GET /api/observatory/terrain/tables
 * (routes/terrain_tables.py); the rectangle is painted by terrainCanvas.ts;
 * the tap-to-read card is TerrainTableSheet.tsx; TerrainPage.tsx wires them.
 *
 * Prompt that produced it: "is there a way to visualize sql tables in my
 * terrain view? curious to put my tables on there somewhere" / "i want them
 * to be sized by how much is in there and learn more about the shapes of the
 * tables through this exercise" / "i want them to cluster differently though.
 * maybe a little off in their own section of the personal vault and then more
 * organized" / "B shelves on the outer side away from the app code".
 */
import type { TerrainData, TerrainFile, TerrainTable, TerrainTables } from './api';
import type { TerrainEdge, TerrainNode } from './terrainGraph';

/** How wide one column's stripe is, in the map's world units. */
export const COLUMN_WIDTH = 7;

/** The band across the top of every table that stands for its column names.
 * An empty table is this band and nothing under it. */
export const HEADER_HEIGHT = 6;

/**
 * How rows become height: `ROW_SCALE × √rows`, under the header band.
 *
 * A square root rather than a straight line because the row counts here span
 * four orders of magnitude (a 15-row lookup table beside a 40,000-row log).
 * On a straight line, any scale that keeps the biggest table on the screen
 * flattens every small one to nothing. The square root keeps order — more
 * rows is always taller — and keeps both ends readable; the price is that
 * twice as tall means FOUR times the rows, which the card says out loud.
 */
export const ROW_SCALE = 0.8;

export interface TableSize {
  /** Full width: one COLUMN_WIDTH stripe per column. */
  width: number;
  /** Full height: the header band plus the rows' height. */
  height: number;
  /** Just the part under the header — 0 for an empty table. */
  rowsHeight: number;
}

/** Work out a table's drawn rectangle from its column and row counts. */
export function tableSize(table: TerrainTable): TableSize {
  const width = Math.max(1, table.columns.length) * COLUMN_WIDTH;
  const rowsHeight = ROW_SCALE * Math.sqrt(Math.max(0, table.rows));
  return { width, height: HEADER_HEIGHT + rowsHeight, rowsHeight };
}

/** The circle that just encloses a table's rectangle — half its diagonal. The
 * physics only knows circles, so this is the body that keeps the dots out
 * from under the table. */
export function tableCollideRadius(table: TerrainTable): number {
  const { width, height } = tableSize(table);
  return Math.hypot(width, height) / 2;
}

/** The node id the graph gives a table's synthetic file. */
export function tableNodeId(repoId: string, databasePath: string, tableName: string): string {
  return `${repoId}:file:${databasePath}/${tableName}`;
}

/**
 * Add one synthetic file per table to the payload, under the database file's
 * own path, in the repo that holds it.
 *
 * Returns the payload untouched when there is nothing to place: no tables
 * yet, a database outside every repo (`repo` null), or a repo the payload
 * doesn't carry (switched off by the repo chips, say).
 */
export function addTableNodes(data: TerrainData, tables: TerrainTables | undefined): TerrainData {
  if (!tables || tables.repo === null || tables.path === null || tables.tables.length === 0) {
    return data;
  }
  const databasePath = tables.path;
  let placed = false;
  const repos = data.repos.map((repo) => {
    if (repo.id !== tables.repo) return repo;
    placed = true;
    const tableFiles: TerrainFile[] = tables.tables.map((table) => ({
      path: `${databasePath}/${table.name}`,
      touches: [],
      sessions: [],
      table,
    }));
    return { ...repo, files: [...repo.files, ...tableFiles] };
  });
  return placed ? { ...data, repos } : data;
}

/**
 * Turn foreign keys into map edges: one line from the table that HOLDS the
 * key to the table it POINTS AT.
 *
 * A key pointing at a table that isn't on the map is skipped rather than left
 * dangling, and a table pointing at itself (a `merged_into` column, say) is
 * skipped too — a line from a body to itself has nowhere to go; the card
 * still lists it. Two keys to the same table make one line, not two on top
 * of each other.
 */
export function foreignKeyEdges(nodes: readonly TerrainNode[]): TerrainEdge[] {
  const byName = new Map<string, string>();
  for (const node of nodes) {
    if (node.file?.table) byName.set(`${node.repoId}\n${node.file.table.name}`, node.id);
  }
  const edges: TerrainEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const table = node.file?.table;
    if (!table) continue;
    for (const key of table.foreign_keys) {
      const targetId = byName.get(`${node.repoId}\n${key.table}`);
      if (targetId === undefined || targetId === node.id) continue;
      const pair = `${node.id}\n${targetId}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push({ source: node.id, target: targetId, kind: 'fk' });
    }
  }
  return edges;
}

/** The tables that point AT this one — the other end of their foreign keys.
 * A table can't see these in its own definition, which is exactly why the
 * card lists them. */
export function tablesPointingAt(
  tables: readonly TerrainTable[],
  tableName: string,
): { table: string; column: string }[] {
  const out: { table: string; column: string }[] = [];
  for (const other of tables) {
    for (const key of other.foreign_keys) {
      if (key.table === tableName) out.push({ table: other.name, column: key.column });
    }
  }
  return out;
}

export type TableShapeKind = 'empty' | 'join' | 'tall' | 'wide' | 'even';

export interface TableShape {
  kind: TableShapeKind;
  /** Two or three words naming the shape. */
  title: string;
  /** One or two plain sentences on what a table of this shape usually is. */
  meaning: string;
}

/**
 * Say, in plain English, what kind of shape a table has.
 *
 * Read off the same rectangle the map draws (so the words always agree with
 * the picture): more than twice as tall as wide is "tall", more than twice as
 * wide as tall is "wide". Two shapes are certain rather than rules of thumb —
 * an empty table, and a pure join table (every column is a foreign key) — so
 * those are said flatly; the others say "usually", because a shape suggests
 * what a table is for without proving it.
 */
export function describeTableShape(table: TerrainTable): TableShape {
  if (table.rows === 0) {
    return {
      kind: 'empty',
      title: 'Empty',
      meaning: 'The structure exists — the columns are defined — but no rows have been stored in it yet.',
    };
  }
  const keyColumns = new Set(table.foreign_keys.map((key) => key.column));
  if (table.columns.length > 0 && table.columns.every((column) => keyColumns.has(column.name))) {
    return {
      kind: 'join',
      title: 'A join table',
      meaning:
        'Every column here points at another table. It holds no facts of its own — each row only says "this one goes with that one".',
    };
  }
  const { width, height } = tableSize(table);
  if (height > width * 2) {
    return {
      kind: 'tall',
      title: 'Tall and narrow',
      meaning:
        'Few columns, many rows. Tables this shape are usually logs or lists of links: each row is one small event, and there are a lot of them.',
    };
  }
  if (width > height * 2) {
    return {
      kind: 'wide',
      title: 'Wide and short',
      meaning:
        'Many columns, few rows. Tables this shape usually hold things: each row is one whole item, described in detail.',
    };
  }
  return {
    kind: 'even',
    title: 'Evenly built',
    meaning: 'Columns and rows in balance — neither a thin log nor a short list of detailed items.',
  };
}

/** Bytes as a short human size — "2.3 MB". Null stays "not measured": the
 * server sends null when this SQLite can't measure, and that isn't zero. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'not measured';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- the shelves: where each table stands ------------------------------------

/** The shelf label for tables that are joined to nothing. */
export const LONERS_LABEL = 'on their own';

export interface TableFamily {
  /** What the shelf is called — see familyLabel. */
  label: string;
  /** Parent first, then the tables that point at it, each followed by its own
   * children — so a table stands next to the one it belongs to. */
  tables: TerrainTable[];
}

/** Name a family from its tables' own names: the first word most of them
 * share ("todo" for todos / todo_fronts / todo_subtasks…), or, when no word
 * covers more than half, the name of the table the others point at most. */
function familyLabel(tables: readonly TerrainTable[], pointedAt: ReadonlyMap<string, number>): string {
  const firstWords = new Map<string, number>();
  for (const table of tables) {
    const word = table.name.split('_')[0].replace(/s$/, '');
    firstWords.set(word, (firstWords.get(word) ?? 0) + 1);
  }
  const [word, count] = [...firstWords.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (count > tables.length / 2) return word;
  return [...tables].sort(
    (a, b) => (pointedAt.get(b.name) ?? 0) - (pointedAt.get(a.name) ?? 0) || a.name.localeCompare(b.name),
  )[0].name;
}

/**
 * Sort the tables into families: groups joined to each other by foreign keys.
 *
 * This is "connected components" — start at any table, follow its foreign
 * keys in both directions until nothing new turns up, and everything reached
 * is one family. Bigger families come first; tables joined to nothing are
 * gathered into one last family (LONERS_LABEL), biggest first.
 *
 * Inside a family the order is a walk down from the parents: a table that
 * points at nobody in the family (a parent) comes first, then each table that
 * points at it, each followed at once by ITS children — except that a table
 * with several parents waits until all of them are standing. A key to a table
 * that isn't in the list, or to itself, joins nothing.
 */
export function tableFamilies(tables: readonly TerrainTable[]): TableFamily[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const parentsOf = new Map<string, Set<string>>();   // table → tables it points at
  const childrenOf = new Map<string, Set<string>>();  // table → tables pointing at it
  for (const table of tables) {
    parentsOf.set(table.name, new Set());
    childrenOf.set(table.name, new Set());
  }
  for (const table of tables) {
    for (const key of table.foreign_keys) {
      if (key.table === table.name || !byName.has(key.table)) continue;
      parentsOf.get(table.name)!.add(key.table);
      childrenOf.get(key.table)!.add(table.name);
    }
  }
  const pointedAt = new Map(tables.map((table) => [table.name, childrenOf.get(table.name)!.size]));
  const bySize = (a: string, b: string) =>
    byName.get(b)!.rows - byName.get(a)!.rows || a.localeCompare(b);

  const families: TableFamily[] = [];
  const loners: TerrainTable[] = [];
  const grouped = new Set<string>();
  for (const table of tables) {
    if (grouped.has(table.name)) continue;
    // Gather the family: everything reachable along keys, either direction.
    const members = new Set<string>([table.name]);
    const queue = [table.name];
    while (queue.length > 0) {
      const name = queue.pop()!;
      for (const next of [...parentsOf.get(name)!, ...childrenOf.get(name)!]) {
        if (members.has(next)) continue;
        members.add(next);
        queue.push(next);
      }
    }
    for (const name of members) grouped.add(name);
    if (members.size === 1) {
      loners.push(table);
      continue;
    }
    // Order it: parents first (most pointed-at first), children behind them.
    const ordered: TerrainTable[] = [];
    const placed = new Set<string>();
    const walk = (name: string) => {
      if (placed.has(name)) return;
      placed.add(name);
      ordered.push(byName.get(name)!);
      for (const child of [...childrenOf.get(name)!].sort(bySize)) {
        // A table with two parents waits for the second one: it stands after
        // everything it points at, not just the first parent to be reached.
        if ([...parentsOf.get(child)!].every((parent) => placed.has(parent))) walk(child);
      }
    };
    const parents = [...members]
      .filter((name) => parentsOf.get(name)!.size === 0)
      .sort((a, b) => pointedAt.get(b)! - pointedAt.get(a)! || bySize(a, b));
    for (const parent of parents) walk(parent);
    // A ring of tables that all point at each other has no parent to start
    // from; whatever the walk missed still gets a place.
    for (const name of [...members].sort(bySize)) walk(name);
    families.push({ label: familyLabel(ordered, pointedAt), tables: ordered });
  }

  families.sort((a, b) => b.tables.length - a.tables.length || a.label.localeCompare(b.label));
  if (loners.length > 0) {
    loners.sort((a, b) => bySize(a.name, b.name));
    families.push({ label: LONERS_LABEL, tables: loners });
  }
  return families;
}

/** A shelf never runs wider than this; a family with more tables than fit
 * continues on the next shelf down, unlabelled. */
export const SHELF_MAX_WIDTH = 900;
/** Every table gets at least this much floor, however narrow it is, so its
 * name — always wider than a two-column table — has room to be read. */
const SHELF_MIN_SLOT = 120;
/** Floor between one table's slot and the next. */
const SHELF_SLOT_GAP = 20;
/** Headroom above a shelf's tallest table, for the names that sit on top. */
const SHELF_NAME_ROOM = 48;
/** Room under a shelf's baseline, for the foreign-key lines that run there. */
const SHELF_LINE_ROOM = 64;

export interface ShelfLayout {
  /** Table name → the CENTRE of its rectangle, measured from the section's
   * top-left corner. */
  positions: Map<string, { x: number; y: number }>;
  /** One per family: its name, and where the shelf it labels begins — `x` the
   * shelf's left end, `y` its baseline. */
  shelfLabels: { text: string; x: number; y: number }[];
  width: number;
  height: number;
}

/**
 * Stand the tables on their shelves: one family per shelf, left to right in
 * family order, every table's BOTTOM edge on the shelf's baseline.
 *
 * Pure arithmetic from the same tableSize the canvas draws with, so a table
 * can never be placed for a different size than it's painted at.
 */
export function shelfLayout(tables: readonly TerrainTable[]): ShelfLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const shelfLabels: { text: string; x: number; y: number }[] = [];
  let top = 0;
  let width = 0;

  for (const family of tableFamilies(tables)) {
    // Break the family into shelves no wider than SHELF_MAX_WIDTH.
    const shelves: TerrainTable[][] = [[]];
    let run = 0;
    for (const table of family.tables) {
      const slot = Math.max(tableSize(table).width, SHELF_MIN_SLOT) + SHELF_SLOT_GAP;
      if (run + slot > SHELF_MAX_WIDTH && shelves[shelves.length - 1].length > 0) {
        shelves.push([]);
        run = 0;
      }
      shelves[shelves.length - 1].push(table);
      run += slot;
    }

    shelves.forEach((shelf, shelfIndex) => {
      const tallest = Math.max(...shelf.map((table) => tableSize(table).height));
      const baseline = top + SHELF_NAME_ROOM + tallest;
      let x = 0;
      for (const table of shelf) {
        const size = tableSize(table);
        const slot = Math.max(size.width, SHELF_MIN_SLOT) + SHELF_SLOT_GAP;
        positions.set(table.name, { x: x + slot / 2, y: baseline - size.height / 2 });
        x += slot;
      }
      if (shelfIndex === 0) shelfLabels.push({ text: family.label, x: 0, y: baseline });
      width = Math.max(width, x);
      top = baseline + SHELF_LINE_ROOM;
    });
  }
  return { positions, shelfLabels, width, height: top };
}
