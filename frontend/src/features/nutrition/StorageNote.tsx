/**
 * StorageNote.tsx — whether the body keeps a store of a nutrient, or needs it steadily.
 *
 * Two pieces: StorageTag, the small marker under each nutrient on the
 * Nutrients list ("Body stores it", "Needed steadily", "Store not stated"),
 * and StorageCard, the card on a nutrient's own page that says the same thing
 * in a line, then shows the NIH ODS fact sheet's sentences it rests on, word
 * for word and linked. The card closes with the sheet's own definition of the
 * RDA — an *average daily* intake — since that's what makes a low day on a
 * stored nutrient matter less than it looks.
 *
 * Nutrients ODS has no sheet for (energy, the macronutrients, fiber, sodium)
 * get no marker, and their card says there's no sourced answer.
 *
 * Prompt that produced it: "Also wanting to know which nutrients I need to get
 * daily vs. which can build up in my system."
 *
 * Data: `storage` on GET /api/nutrition/day and /api/nutrition/nutrient/<key>
 * (routes/nutrition.py → nutrient_storage.py). Touches: ./types.ts,
 * ./NutritionPage.tsx, ./NutrientPage.tsx, ./Nutrition.module.css.
 */
import type { NutrientStorage, StorageKind } from './types';
import styles from './Nutrition.module.css';

const TAG_CLASS: Record<StorageKind, string> = {
  stores: styles.storageStores,
  steady: styles.storageSteady,
  unclear: styles.storageUnclear,
  unsourced: '',
};

/** The list's marker for one nutrient; nothing for a nutrient with no sourced answer. */
export function StorageTag({ kind, label }: { kind: StorageKind; label: string }) {
  if (kind === 'unsourced') return null;
  return <span className={`${styles.storageTag} ${TAG_CLASS[kind]}`}>{label}</span>;
}

/** A nutrient page's card: the answer in a line, then the sheet's own sentences behind it. */
export function StorageCard({ storage, label }: { storage: NutrientStorage; label: string }) {
  if (storage.kind === 'unsourced' || !storage.sheet) {
    return (
      <section className={styles.card}>
        <div className={styles.cardHead}>Daily, or does it build up?</div>
        <p className={styles.muted}>
          No sourced answer for {label.toLowerCase()} yet — the NIH Office of Dietary Supplements has no fact sheet
          for it.
        </p>
      </section>
    );
  }
  return (
    <section className={styles.card}>
      <div className={styles.rowTop}>
        <div className={styles.cardHead}>Daily, or does it build up?</div>
        <StorageTag kind={storage.kind} label={storage.label} />
      </div>
      <p className={styles.factText}>{storage.summary}</p>
      {storage.lasts ? <p className={styles.muted}>How long, per the sheet: {storage.lasts}</p> : null}
      {storage.quotes.length ? (
        <ul className={styles.factList}>
          {storage.quotes.map((quote) => (
            <li key={quote}>“{quote}”</li>
          ))}
        </ul>
      ) : storage.sheet.missing ? null : (
        <p className={styles.muted}>The sheet has no sentence on whether the body stores it.</p>
      )}
      {storage.average ? (
        <p className={styles.muted}>
          Every target here is an average over days, not a line to clear each day — the sheet defines it: “
          {storage.average}”
        </p>
      ) : null}
      <p className={styles.sources}>
        {storage.sheet.missing ? 'The sheet isn’t saved on this install yet, so its sentences can’t be shown — ' : 'Quoted from the '}
        {storage.sheet.missing ? 'read it at ' : `${storage.sheet.publisher}, `}
        <a href={storage.sheet.url} target="_blank" rel="noreferrer">
          {storage.sheet.name}
        </a>
        . The one-line reading above is ours; the quotes are the evidence.
      </p>
    </section>
  );
}
