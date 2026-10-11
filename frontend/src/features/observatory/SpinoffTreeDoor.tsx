import { useNavigate } from '@tanstack/react-router';
import styles from './NightCrew.module.css';

/**
 * SpinoffTreeDoor — the row at the bottom of the roster that goes to
 * /observatory/tree, the family tree of which session was spun off from
 * which. Same door shape as Night crew / Helpers / Research (borrows
 * NightCrew.module.css), so the roster's doors read as one idiom. Carries no
 * census: the page loads its list when she clicks through.
 */
export function SpinoffTreeDoor() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={styles.door}
      onClick={() => void navigate({ to: '/observatory/tree' })}
      data-track="observatory-spinoff-tree-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>Spinoff tree</span>
        <span className={styles.doorLine}>Which session was spun off from which</span>
      </span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
