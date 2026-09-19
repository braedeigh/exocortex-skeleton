import { Link } from '@tanstack/react-router';
import type { TerrainTable, TerrainTableNotes } from './api';
import { describeTableShape, formatBytes, tablesPointingAt } from './tableNodes';
import styles from './TerrainTableSheet.module.css';

/**
 * TerrainTableSheet — what the map shows when she taps a table: the table
 * read out in plain English, so the rectangle she tapped stops being a shape
 * and becomes something she understands.
 *
 * Top to bottom it answers, in the order the questions come up:
 *
 *   WHAT'S IN IT  the hand-written description of the information the table
 *               contains (table_notes.json, served with the table).
 *   HOW MUCH    rows, columns, and bytes on disk — what the rectangle's size
 *               was a picture of — with the scale said out loud, because the
 *               height is a square root and a picture with a hidden scale is
 *               a lie by omission.
 *   WHAT SHAPE  a name for the shape and what tables of that shape usually
 *               are (tableNodes.ts describeTableShape).
 *   COLUMNS     every column, its type, and what it IS: the key that
 *               identifies a row, a pointer into another table, or a required
 *               value.
 *   JOINED TO   both directions of its foreign keys. The ones pointing IN
 *               aren't written anywhere in this table's own definition, which
 *               is exactly why they're worth listing. Each name is a button
 *               that jumps to that table's card.
 *   WHERE ITS ROWS COME FROM
 *               the note's account of what fills the table, and whether it's
 *               a copy that can be rebuilt or the only record there is.
 *   CODE THAT TOUCHES IT
 *               the files that create it, write to it, and read it — found by
 *               the server searching the code, so it can't go stale. Each is
 *               a button that opens the file in the map's code window.
 *
 * This file is only the words and layout; all of it is drawn from the table
 * description the map already holds (GET /api/observatory/terrain/tables), so
 * opening a card costs no request. Shown as the About side of
 * TerrainTableWindow.tsx (whose Rows side shows the table's actual contents);
 * the door at the bottom leads to the SQL room (/terrain/sql), where the same
 * table can be queried.
 *
 * Prompt that produced it: "i want them to be sized by how much is in there
 * and learn more about the shapes of the tables through this exercise" / "for
 * each one i want a description of the information it contains and the files
 * that created it and write to it or that otherwise interact with it".
 */

/** What each `kind` of table means, in a sentence — the difference that
 * matters most is whether wiping the table loses anything. */
const KIND_MEANING: Record<TerrainTableNotes['kind'], { label: string; meaning: string }> = {
  mirror: {
    label: 'A rebuildable copy',
    meaning: 'The truth lives somewhere else. This table could be emptied and filled again from its source without losing anything.',
  },
  record: {
    label: 'The only record',
    meaning: 'These rows exist nowhere else. They are events that happened once, so this table can never be rebuilt — only backed up.',
  },
  store: {
    label: 'The database of record',
    meaning: 'This is where the app actually keeps its collections. Everything else that shows them is a copy of this.',
  },
  mixed: {
    label: 'Part copy, part record',
    meaning: 'Some rows can be regenerated at any time; the ones set by hand cannot.',
  },
};

const CODE_GROUPS = [
  { key: 'creates', label: 'Creates it' },
  { key: 'writes', label: 'Writes to it' },
  { key: 'reads', label: 'Reads it' },
] as const;
export function TerrainTableSheet({
  table,
  allTables,
  onPickTable,
  onOpenFile,
}: {
  table: TerrainTable;
  /** Every table on the map — needed to find the keys pointing IN. */
  allTables: readonly TerrainTable[];
  /** Jump to another table's card. */
  onPickTable: (tableName: string) => void;
  /** Open one of the code files in the map's code window. */
  onOpenFile: (path: string) => void;
}) {
  const shape = describeTableShape(table);
  const pointsAt = table.foreign_keys;
  const pointedAtBy = tablesPointingAt(allTables, table.name);
  const foreignColumns = new Map(table.foreign_keys.map((key) => [key.column, key]));
  // A primary key can be several columns TOGETHER (a composite key): no one of
  // them identifies a row alone, so each is described as a part, not the whole.
  const primaryKeyColumns = table.columns.filter((column) => column.pk).length;

  /** Say what one column is — its key role(s) first, since a column can be
   * both part of the primary key AND a pointer into another table. */
  const roleOf = (column: TerrainTable['columns'][number]): string => {
    const key = foreignColumns.get(column.name);
    const roles: string[] = [];
    if (column.pk) {
      roles.push(
        primaryKeyColumns > 1
          ? `part of the primary key — the ${primaryKeyColumns} key columns together identify the row`
          : 'primary key — identifies the row',
      );
    }
    if (key) roles.push(`points at ${key.table}${key.to ? `.${key.to}` : ''}`);
    if (roles.length > 0) return roles.join(' · ');
    return column.notnull ? 'required' : 'optional';
  };

  return (
    <div className={styles.body}>
      {/* WHAT'S IN IT — the description, first, because "what is this" comes
          before "how big is it". Three cases, kept apart on purpose: a note
          (show it); null = the server looked and nobody has described this
          table (say so); undefined = the server predates notes altogether
          (say nothing — "nobody has written one" would be a guess). */}
      {table.notes !== undefined ? (
        <p className={styles.holds}>
          {table.notes ? table.notes.holds : 'Nobody has written a description of this table yet.'}
        </p>
      ) : null}

      {/* HOW MUCH — the three numbers the rectangle stands for. */}
      <div className={styles.facts}>
        <div className={styles.fact}>
          <span className={styles.factNumber}>{table.rows.toLocaleString()}</span>
          <span className={styles.factLabel}>{table.rows === 1 ? 'row' : 'rows'} — its height</span>
        </div>
        <div className={styles.fact}>
          <span className={styles.factNumber}>{table.columns.length}</span>
          <span className={styles.factLabel}>
            {table.columns.length === 1 ? 'column' : 'columns'} — its width
          </span>
        </div>
        <div className={styles.fact}>
          <span className={styles.factNumber}>{formatBytes(table.bytes)}</span>
          <span className={styles.factLabel}>
            on disk
            {table.index_bytes ? ` · plus ${formatBytes(table.index_bytes)} of indexes` : ''}
          </span>
        </div>
      </div>
      <p className={styles.note}>
        Width is exact: one stripe per column. Height grows with the square root of the rows, so a
        table twice as tall holds about four times as many.
      </p>

      {/* WHAT SHAPE */}
      <section className={styles.section}>
        <h3 className={styles.heading}>{shape.title}</h3>
        <p className={styles.prose}>{shape.meaning}</p>
      </section>

      {/* COLUMNS — each with what it is, not just what it's called. */}
      <section className={styles.section}>
        <h3 className={styles.heading}>Columns</h3>
        <ul className={styles.columns}>
          {table.columns.map((column) => {
            const key = foreignColumns.get(column.name);
            return (
              <li key={column.name} className={styles.column}>
                <span
                  className={[
                    styles.swatch,
                    column.pk ? styles.swatchPrimary : key ? styles.swatchForeign : '',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <span className={styles.columnName}>{column.name}</span>
                <span className={styles.columnType}>{column.type || 'any'}</span>
                <span className={styles.columnRole}>{roleOf(column)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* JOINED TO — out, then in. */}
      {pointsAt.length > 0 || pointedAtBy.length > 0 ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>Joined to</h3>
          {pointsAt.length > 0 ? (
            <>
              <p className={styles.prose}>
                Points at — each row here belongs to one row over there:
              </p>
              <div className={styles.links}>
                {pointsAt.map((key) => (
                  <button
                    key={`${key.column}:${key.table}`}
                    type="button"
                    className={styles.link}
                    onClick={() => onPickTable(key.table)}
                  >
                    <span className={styles.linkName}>{key.table}</span>
                    <span className={styles.linkVia}>through {key.column}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {pointedAtBy.length > 0 ? (
            <>
              <p className={styles.prose}>
                Pointed at by — one row here can have many rows over there:
              </p>
              <div className={styles.links}>
                {pointedAtBy.map((other) => (
                  <button
                    key={`${other.table}:${other.column}`}
                    type="button"
                    className={styles.link}
                    onClick={() => onPickTable(other.table)}
                  >
                    <span className={styles.linkName}>{other.table}</span>
                    <span className={styles.linkVia}>through its {other.column}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* WHERE ITS ROWS COME FROM — and whether wiping it would lose anything. */}
      {table.notes ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>Where its rows come from</h3>
          <p className={styles.prose}>{table.notes.source}</p>
          <p className={styles.prose}>
            <strong>{KIND_MEANING[table.notes.kind].label}.</strong>{' '}
            {KIND_MEANING[table.notes.kind].meaning}
          </p>
        </section>
      ) : null}

      {/* CODE THAT TOUCHES IT — creates, writes, reads; each file opens. Left
          out entirely when the payload carries no scan (a server that predates
          it): "no file found" would then be a claim nobody checked. */}
      {table.code !== undefined ? (
      <section className={styles.section}>
        <h3 className={styles.heading}>Code that touches it</h3>
        {CODE_GROUPS.map((group) => {
          const hits = table.code?.[group.key] ?? [];
          return (
            <div key={group.key} className={styles.codeGroup}>
              <span className={styles.codeLabel}>{group.label}</span>
              {hits.length > 0 ? (
                <div className={styles.links}>
                  {hits.map((hit) => (
                    <button
                      key={hit.path}
                      type="button"
                      className={styles.link}
                      onClick={() => onOpenFile(hit.path)}
                    >
                      <span className={styles.fileName}>{hit.path}</span>
                      <span className={styles.linkVia}>first at line {hit.line}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <span className={styles.codeNone}>no file found</span>
              )}
            </div>
          );
        })}
        <p className={styles.note}>
          Found by searching the app's Python for SQL that names this table. It can't see code
          that reaches the table through another file's functions, or the tools that read every
          table (the SQL room, this map) — "where its rows come from" above covers the indirect
          path.
        </p>
      </section>
      ) : null}

      {table.indexes.length > 0 ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>Indexes</h3>
          <p className={styles.prose}>
            Shortcuts the database keeps so it can find rows without reading the whole table:{' '}
            {table.indexes.map((index) => index.name).join(', ')}.
          </p>
        </section>
      ) : null}

      <Link to="/terrain/sql" className={styles.door}>
        Ask it things in the SQL room →
      </Link>
    </div>
  );
}
