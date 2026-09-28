/**
 * FoodNav.tsx — the row of doors at the top of every Food-area page: the map
 * (/food), every food (/food/foods), and the review list of the machine's
 * suggested sources (/food/review) with how many are waiting.
 *
 * The count comes from `eco_proposals` on /api/data/ecosystem — the same
 * query the map polls, so it costs nothing extra while the map is open. For
 * a public viewer the key is absent and the Review door is left off.
 *
 * Touches: ./useEcosystemData.ts, ./proposals.ts, ./FoodArea.module.css.
 *
 * Prompt that produced it: "remaking the frontend to be in one place" — the
 * ecosystem map, food profiles and research as one Food area.
 */
import { Link } from '@tanstack/react-router';
import { useEcosystemData } from './useEcosystemData';
import styles from './FoodArea.module.css';

export type FoodNavPage = 'map' | 'foods' | 'review' | 'food';

export function FoodNav({ current }: { current: FoodNavPage }) {
  const { data } = useEcosystemData();
  const proposals = data?.eco_proposals;
  const doorClass = (page: FoodNavPage) => `${styles.navLink} ${current === page ? styles.navActive : ''}`;
  return (
    <nav className={styles.nav} aria-label="Food">
      <Link to="/food" className={doorClass('map')}>
        🗺 Map
      </Link>
      <Link to="/food/foods" className={doorClass('foods')}>
        🥕 Foods
      </Link>
      {proposals ? (
        <Link to="/food/review" search={{}} className={doorClass('review')}>
          🔎 Review
          {proposals.length ? <span className={styles.navCount}>{proposals.length} waiting</span> : null}
        </Link>
      ) : null}
    </nav>
  );
}
