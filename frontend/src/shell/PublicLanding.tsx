import { Link } from '@tanstack/react-router';
import { FakeTerminal } from './FakeTerminal';
import styles from './PublicLanding.module.css';

/**
 * Mobile public landing at "/" (desktop public visitors never see this — they
 * get the FakeTerminal docked in SplitLayout's left pane and land on /todos
 * instead; see routes/index.tsx). The old split.html public mode simply had
 * no intro on phones; this is the mobile upgrade: the same fake-terminal
 * intro full-bleed, with explore/sign-in actions pinned below it.
 */
export function PublicLanding() {
  return (
    <div className={styles.wrap}>
      <FakeTerminal />
      <div className={styles.actions}>
        {/* The map is the one page a visitor can open (public_config). */}
        <Link to="/terrain/files" className={styles.explore}>
          Explore the map
        </Link>
        {window.PUBLIC_ONLY ? null : (
          <a href="/login" className={styles.signIn}>
            Sign in
          </a>
        )}
      </div>
    </div>
  );
}
