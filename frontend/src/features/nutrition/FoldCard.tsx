/**
 * FoldCard.tsx — one section of the Nutrients pages that folds shut behind
 * its title and opens with a tap, remembering which on this device.
 *
 * It's the app's collapsible card (../body/CollapsibleCard.tsx — a <details>
 * with a chevron, open/closed kept in localStorage) wearing the Nutrients
 * look from ./Nutrition.module.css (.fold*). The `note` rides on the title
 * line and shows while shut, so a closed page still says what's in each
 * section. Keys are prefixed `nutrients.` so they don't meet other pages'.
 *
 * Used by ./NutritionPage.tsx, ./NutrientPage.tsx, ./FoodShares.tsx,
 * ./Highlights.tsx, ./StorageNote.tsx, ./MealPrepPlan.tsx.
 *
 * Prompt that produced it: "it's currently a lot to scroll, so i'm wondering
 * if they could be collapsed and openable or something".
 */
import type { ReactNode } from 'react';
import { CollapsibleCard } from '../body/CollapsibleCard';
import styles from './Nutrition.module.css';

const FOLD_CLASSES = {
  card: `${styles.card} ${styles.fold}`,
  summary: styles.foldSummary,
  arrow: styles.foldArrow,
  title: styles.foldTitle,
  note: styles.foldNote,
};

export function FoldCard({
  cardKey,
  title,
  note,
  defaultOpen = false,
  children,
}: {
  cardKey: string;
  title: string;
  note?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <CollapsibleCard
      cardKey={`nutrients.${cardKey}`}
      title={title}
      note={note}
      defaultOpen={defaultOpen}
      classes={FOLD_CLASSES}
    >
      <div className={styles.foldBody}>{children}</div>
    </CollapsibleCard>
  );
}
