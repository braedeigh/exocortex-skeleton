import { SqlLabPage } from './sqlab/SqlLabPage';
import styles from './TerrainSqlView.module.css';
import { TerrainRoomHeader } from './TerrainRoomHeader';

/**
 * TerrainSqlView — the database, one of the terrain's rooms.
 *
 * Terrain draws the system as a body in SPACE (which files are hot, which
 * agents are where) and /terrain/usage ranks that same body by ATTENTION. This
 * is the third axis: what the body has actually STORED. Same organism, so it
 * lives under /terrain rather than off in the More menu on its own.
 *
 * A whole page now (/terrain/sql, routes/terrain_.sql.tsx — un-nested, so the
 * map unmounts and this room owns the screen). It used to float over the live
 * map as an inset glass panel whose glass had to be pushed to 98% opaque
 * before the code editor was readable — the proof it wanted to be a page. You
 * reach it through the rooms hallway (TerrainRoomsIndex), and
 * "← Rooms" reopens the hallway.
 *
 * The body is SqlLabPage unchanged, not a copy. It brings its own Map / Console
 * / Sandbox switch, and its own scrolling — this file is only the frame around
 * it. Keeping it as one component means the standalone /sql page and this room
 * can never drift apart.
 *
 * Prompt that produced this frame: "they aren't modals. They need to be
 * separate pages."
 */
export function TerrainSqlView() {
  return (
    <section className={styles.view} aria-label="The database">
      <TerrainRoomHeader title="What it's stored" sub="The same system, as data — its shape, and a way to ask it things." />

      <div className={styles.body}>
        <SqlLabPage />
      </div>
    </section>
  );
}
