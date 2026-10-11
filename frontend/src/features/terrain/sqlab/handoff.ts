/**
 * handoff.ts — hand a query to the SQL room from somewhere else in the app.
 *
 * The SQL room (SqlLabPage.tsx) remembers two things between visits in the
 * browser's storage: the query in its console, and which of its views was
 * open. It reads both when it opens. So "open this query in the SQL room"
 * needs no new door — write the query where the room already looks, point it
 * at the Console, and go there.
 *
 * The storage keys live here, and SqlLabPage imports them from here, so the
 * room and anything handing it a query can never disagree about the names.
 *
 * Used by the Terrain map's table window (terrain/TerrainTableRows.tsx), whose
 * "show me the SQL" line can be opened in the room.
 */

/** Where the console's query text is remembered. */
export const SQL_ROOM_QUERY_KEY = 'sqlab_query';
/** Where the room remembers which view was open ('map' | 'console' | 'sandbox'). */
export const SQL_ROOM_VIEW_KEY = 'sqlab_view';

/** Leave a query for the SQL room to open with, on its Console view. Storage
 * can be unavailable (private browsing); then the room simply opens as it was,
 * which is a smaller loss than an error. */
export function handQueryToSqlRoom(sql: string): void {
  try {
    localStorage.setItem(SQL_ROOM_QUERY_KEY, sql);
    localStorage.setItem(SQL_ROOM_VIEW_KEY, 'console');
  } catch {
    /* no storage — the room opens as it was */
  }
}
