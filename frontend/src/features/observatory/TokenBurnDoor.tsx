import { useNavigate } from '@tanstack/react-router';
import styles from './NightCrew.module.css';

/**
 * TokenBurnDoor — the row on the roster that goes to /observatory/burn: how
 * many tokens the agents use, where, and when (TokenBurnPage.tsx).
 *
 * A PLAIN DOOR, NO CENSUS, like Night crew's: adding up the spending is a
 * query over every turn on record, and the roster remounts every time she
 * comes back to it — so the numbers load only once she walks through.
 *
 * `slim` is the one-line version for the foot of the desktop map (RosterMap.tsx):
 * the title and its warning only, with the "wanting" tint kept.
 */
export function TokenBurnDoor({ slim = false }: { slim?: boolean } = {}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={[styles.door, slim ? styles.doorSlim : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/burn' })}
      data-track="observatory-burn-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>Token burn</span>
        <span className={styles.doorLine}>How many tokens the agents use, where, and when.</span>
      </span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
