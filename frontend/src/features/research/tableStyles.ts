/**
 * tableStyles.ts — the review colours the research tables share: a cell's
 * left edge, a number's card, a ground line. One place, so the grid
 * (TablesPage.tsx) and the opened cell (TableDetail.tsx) can't drift apart.
 */

import type { Review } from './types';
import styles from './TablesPage.module.css';

/** Review state → edge colour: amber waiting for her, green confirmed, red disputed. */
export const REVIEW_CLASS: Record<Review, string> = {
  unreviewed: styles.edgeUnreviewed,
  confirmed: styles.edgeConfirmed,
  disputed: styles.edgeDisputed,
};
