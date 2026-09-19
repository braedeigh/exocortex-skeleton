import { Link } from '@tanstack/react-router';
import type { TerrainTable } from './api';
import { describeTableShape, formatBytes, tablesPointingAt } from './tableNodes';
import styles from './TerrainTableSheet.module.css';

/**
 * TerrainTableSheet — what the map shows when she taps a table: the table
 * read out in plain English, so the rectangle she tapped stops being a shape
 * and becomes something she understands.
 *
 * Top to bottom it answers, in the order the questions come up:
 *
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
 *
 * This file is only the words and layout; all of it is drawn from the table
 * description the map already holds (GET /api/observatory/terrain/tables), so
 * opening a card costs no request. Rendered by TerrainPage.tsx inside its
 * Sheet; the door at the bottom leads to the SQL room (/terrain/sql), where
 * the same table can be queried.
 *
 * Prompt that produced it: "i want them to be sized by how much is in there
 * and learn more about the shapes of the tables through this exercise".
 */
export function TerrainTableSheet({
  table,
  allTables,
  onPickTable,
}: {
  table: TerrainTable;
  /** Every table on the map — needed to find the keys pointing IN. */
  allTables: readonly TerrainTable[];
  /** Jump to another table's card. */
  onPickTable: (tableName: string) => void;
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
