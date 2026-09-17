import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import prose from '../routes/about.module.css';
import styles from './AboutPane.module.css';

/**
 * The public-only mirror's left pane (SplitLayout, desktop, window.PUBLIC_ONLY):
 * the owner's about page docked beside whatever the right pane shows — the
 * Terrain map, where "/" lands there. The copy is CONTENT_DIR/public_about.md,
 * rendered by routes/shell.py and served at /api/about, the same source the
 * /about page reads (and the same query key, so the two never fetch twice).
 * Below the prose, a short list of doors, so a visitor who has read enough
 * has somewhere to go.
 *
 * On the private site's public view the pane is still the FakeTerminal — this
 * one exists for the portfolio, where the person matters more than the mock
 * session. Prompt: "make the left hand side of the screen the about page and
 * the right side automatically display terrain for visitors".
 */
export function AboutPane({ onCollapse }: { onCollapse: () => void }) {
  const { data, isPending } = useQuery({
    queryKey: ['about'],
    queryFn: ({ signal }) => api.get<{ html: string }>('/api/about', signal),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className={styles.pane}>
      <div className={styles.controls}>
        <button type="button" className={styles.controlBtn} aria-label="Hide this pane" onClick={onCollapse}>
          <span aria-hidden="true">&#8249;</span> hide
        </button>
      </div>
      <div className={styles.scroll}>
        <div className={prose.prose}>
          {isPending ? null : data?.html ? (
            <div dangerouslySetInnerHTML={{ __html: data.html }} />
          ) : (
            <div>
              <h1>About</h1>
              <p>
                Create <code>public_about.md</code> in the content directory and this pane fills with it.
              </p>
            </div>
          )}
        </div>
        <nav className={styles.doors} aria-label="Look around">
          <div className={styles.doorsTitle}>Look around</div>
          <Link to="/terrain/map" className={styles.door}>
            <span className={styles.doorName}>Terrain</span>
            <span className={styles.doorLine}>Every file in this system, lit by how recently it was worked on. Tap a code file to read it.</span>
          </Link>
          <Link to="/food-map" className={styles.door}>
            <span className={styles.doorName}>Food map</span>
            <span className={styles.doorLine}>Where the food comes from, and which recipes it feeds.</span>
          </Link>
          <Link to="/kitchen" className={styles.door}>
            <span className={styles.doorName}>Kitchen</span>
            <span className={styles.doorLine}>Grocery list, pantry, what to restock.</span>
          </Link>
          <Link to="/todos" className={styles.door}>
            <span className={styles.doorName}>Dashboard</span>
            <span className={styles.doorLine}>The day view — habits, meals, movement. Some of it frosted.</span>
          </Link>
        </nav>
      </div>
    </div>
  );
}
