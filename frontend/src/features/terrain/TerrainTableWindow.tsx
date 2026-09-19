import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { IconButton } from '../../ui';
import type { TerrainTable } from './api';
import { TerrainTableSheet } from './TerrainTableSheet';
import { TerrainTableRows, type TableJump } from './TerrainTableRows';
import type { TableFilter } from './tableRows';
import styles from './TerrainTableWindow.module.css';

/**
 * TerrainTableWindow — the window a tapped table opens, centred over the
 * TERRAIN PANE rather than over the whole screen.
 *
 * It used to be the app's shared Sheet, which attaches itself to the page and
 * centres on the browser window. That's right for most of the app and wrong
 * here: with the screen split in two, the terrain is only one side, and the
 * card landed straddling the divider — half of it over the other pane, off to
 * one side of the map it was describing. This window is positioned against the
 * terrain page instead (its nearest positioned parent — the same trick
 * FileCodeWindow uses), so "centred" means centred over the map, whichever
 * side of a split the map is on, and the dimming stops at the pane's edge.
 *
 * TWO SIDES, one switch in the header:
 *
 *   ABOUT   the description card (TerrainTableSheet) — what the table holds,
 *           its shape, columns, joins, and the code that touches it.
 *   ROWS    the rows themselves, with search (TerrainTableRows). The window
 *           grows wide for this side: a table of data needs the width a
 *           column of prose doesn't.
 *
 * THE FOOTER is pinned to the bottom of the card and never scrolls away: the
 * two ways onward — into the table's rows, and into the SQL room where it can
 * be queried — stay under her thumb however long the description or the list
 * of rows is. On the Rows side the first of them turns into the way back.
 *
 * It opens on About and goes back to About whenever a DIFFERENT table is
 * picked (the joins inside About are buttons that jump between tables), so
 * she always lands on "what is this" before "what's in it". The one exception
 * is FOLLOWING A JOIN from inside the rows — tapping a `todo_id` to see that
 * to-do — which is a question about rows, so it lands on the other table's
 * Rows side, already filtered to the row the key pointed at. Esc, the ×, and a
 * tap on the dimmed map all close it.
 *
 * Rendered by TerrainPage.tsx in place of its Sheet, for table nodes only.
 *
 * Prompt that produced it: "make the card that pops up for each one center
 * over the open terrain page on the side of the split screen that it's on, and
 * then make it such that i can click into it to see the actual rows themselves
 * with a search function within the rows" / "i want the 'play with in sql
 * room' and the 'see all rows' to float on the bottom of the card fixed to the
 * bottom of the card".
 */
export function TerrainTableWindow({
  table,
  allTables,
  onPickTable,
  onOpenFile,
  onClose,
}: {
  /** The table to show, or null when the window is closed. */
  table: TerrainTable | null;
  allTables: readonly TerrainTable[];
  onPickTable: (tableName: string) => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [side, setSide] = useState<'about' | 'rows'>('about');
  const tableName = table?.name ?? null;
  // Set when a join is followed: which table it leads to, and the filters that
  // pick out the rows it pointed at.
  const [jump, setJump] = useState<{ table: string; filters: TableFilter[] } | null>(null);

  // A different table starts on About again — unless she got here by following
  // a join, which lands on that table's Rows, filtered.
  useEffect(() => {
    setSide(jump !== null && jump.table === tableName ? 'rows' : 'about');
  }, [tableName, jump]);

  // Closing the window forgets the followed join, so opening the same table
  // from the map later starts clean rather than still filtered to one row.
  useEffect(() => {
    if (tableName === null) setJump(null);
  }, [tableName]);

  /** Follow a join: open the other table (or stay, for a table that points
   * at itself) with its rows narrowed to what the key pointed at. */
  const followJump = (next: TableJump) => {
    setJump({ table: next.table, filters: next.filters });
    if (next.table !== tableName) onPickTable(next.table);
  };

  // Close on Esc. The key listener is only attached while the window is open.
  useEffect(() => {
    if (tableName === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tableName, onClose]);

  if (!table) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={side === 'rows' ? `${styles.window} ${styles.windowWide}` : styles.window}
        role="dialog"
        aria-modal="true"
        aria-label={`The ${table.name} table`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{table.name}</h2>
          <div className={styles.switch} role="group" aria-label="What to show">
            <button
              type="button"
              className={side === 'about' ? styles.switchOn : styles.switchOff}
              aria-pressed={side === 'about'}
              onClick={() => setSide('about')}
            >
              About
            </button>
            <button
              type="button"
              className={side === 'rows' ? styles.switchOn : styles.switchOff}
              aria-pressed={side === 'rows'}
              onClick={() => setSide('rows')}
            >
              Rows · {table.rows.toLocaleString()}
            </button>
          </div>
          <IconButton aria-label="Close" onClick={onClose}>
            &times;
          </IconButton>
        </div>

        <div className={styles.body}>
          {side === 'about' ? (
            <TerrainTableSheet
              table={table}
              allTables={allTables}
              onPickTable={(name) => {
                // A jump between tables from About is a fresh look, not a
                // followed key — forget any filters a join left behind.
                setJump(null);
                onPickTable(name);
              }}
              onOpenFile={onOpenFile}
            />
          ) : (
            <TerrainTableRows
              table={table}
              allTables={allTables}
              start={jump !== null && jump.table === table.name ? jump.filters : null}
              onJump={followJump}
            />
          )}
        </div>

        {/* The pinned footer: outside the scrolling body, so it holds still at
            the bottom of the card while everything above it scrolls. */}
        <div className={styles.footer}>
          <Link to="/terrain/sql" className={styles.footerButton}>
            Play with it in the SQL room
          </Link>
          {side === 'about' ? (
            <button type="button" className={styles.footerPrimary} onClick={() => setSide('rows')}>
              See all {table.rows.toLocaleString()} {table.rows === 1 ? 'row' : 'rows'} →
            </button>
          ) : (
            <button type="button" className={styles.footerPrimary} onClick={() => setSide('about')}>
              ← About this table
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
