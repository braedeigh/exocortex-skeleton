import { Link } from '@tanstack/react-router';
import { SqlLabPage } from '../sqlab/SqlLabPage';
import styles from './TerrainSqlView.module.css';

/**
 * TerrainSqlView — the database, as a room inside the Terrain page.
 *
 * Terrain draws the system as a body in SPACE (which files are hot, which
 * agents are where) and /terrain/usage ranks that same body by ATTENTION. This
 * is the third axis: what the body has actually STORED. Same organism, so it
 * belongs in here rather than off in the More menu on its own.
 *
 * A child route through Terrain's <Outlet/>, inset exactly like the usage room
 * — the map stays visible around all four edges, which is what says "you opened
 * a room, you didn't leave." Being a route rather than a panel means it has a
 * URL and the back button works.
 *
 * The body is SqlLabPage unchanged, not a copy. It brings its own Map / Console
 * / Sandbox switch, and its own scrolling — this file is only the frame around
 * it. Keeping it as one component means the standalone /sql page and this room
 * can never drift apart.
 *
 * Prompt that produced this file: "put the SQL thingie inside terrain — cards
 * that you have to navigate into."
 */
export function TerrainSqlView() {
  return (
    <section className={styles.view} aria-label="The database">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>What it's stored</h2>
          <p className={styles.sub}>The same system, as data — its shape, and a way to ask it things.</p>
        </div>
        {/* Back to the map, not a close × — same as the usage room. You step
            out into the terrain that's already visible around this frame. */}
        <Link to="/terrain" className={styles.back} aria-label="Back to the map">
          ← Map
        </Link>
      </header>

      <div className={styles.body}>
        <SqlLabPage />
      </div>
    </section>
  );
}
