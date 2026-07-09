import { CollapsibleCard } from './CollapsibleCard';
import { displayName, triageMeta, untaggedFoods } from './triageHelpers';
import type { BodyData, SafetyTag } from './types';
import styles from './TriageCard.module.css';

export interface TriageCardProps {
  data: BodyData;
  onTag: (name: string, tag: SafetyTag) => void;
}

/**
 * Triage foods card — port of kitchen.js renderFoodTriage. Untagged catalog
 * items, most-bought first, each with Safe / Suspect / Inflammatory buttons.
 * Tagging updates instantly (optimistic), same as the old local re-render.
 */
export function TriageCard({ data, onTag }: TriageCardProps) {
  const items = untaggedFoods(
    data.kitchen_known_items,
    data.kitchen_safety_tags,
    data.kitchen_purchase_counts,
    data.kitchen_last_bought,
  );

  return (
    <CollapsibleCard cardKey="triage" title="Triage foods">
      {items.length === 0 ? (
        <div className={styles.allDone}>&#127881; Every food in your catalog is tagged. Nice triage work.</div>
      ) : (
        <>
          <div className={styles.intro}>
            {items.length} food{items.length === 1 ? '' : 's'} waiting to be triaged. Tap{' '}
            <b className={styles.safeWord}>&#10003; Safe</b> when you&rsquo;ve confirmed it doesn&rsquo;t
            bother you, <b className={styles.suspectWord}>&#9888; Suspect</b> when you think it might,{' '}
            <b className={styles.inflammatoryWord}>&#128293; Inflammatory</b> for known inflammatory
            triggers. Most-bought items first.
          </div>
          <div className={styles.list}>
            {items.map((it) => {
              const meta = triageMeta(it, data.server_date);
              return (
                <div className={styles.row} key={it.name}>
                  <span className={styles.name}>
                    {displayName(it.name)}
                    {meta ? <span className={styles.meta}>{meta}</span> : null}
                  </span>
                  <button
                    type="button"
                    className={`${styles.tagBtn} ${styles.tagSafe}`}
                    title="Mark confirmed safe"
                    onClick={() => onTag(it.name, 'safe')}
                  >
                    &#10003; Safe
                  </button>
                  <button
                    type="button"
                    className={`${styles.tagBtn} ${styles.tagSuspect}`}
                    title="Mark suspect"
                    onClick={() => onTag(it.name, 'suspect')}
                  >
                    &#9888; Suspect
                  </button>
                  <button
                    type="button"
                    className={`${styles.tagBtn} ${styles.tagInflammatory}`}
                    title="Mark known inflammatory"
                    onClick={() => onTag(it.name, 'inflammatory')}
                  >
                    &#128293; Inflammatory
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </CollapsibleCard>
  );
}
