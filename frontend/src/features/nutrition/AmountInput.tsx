/**
 * AmountInput.tsx — a meal amount box that takes grams or a kitchen measure ("1.5 cup", "2 tbsp", "1 large").
 *
 * What this file does: the meal editor on the Nutrients page (NutritionPage.tsx)
 * uses it for each food's amount. A plain number is grams; anything else is
 * read by measureMath.ts against this food's USDA measures (measures.py, via
 * GET /api/nutrition/measures) and shown back as "= 344 g", linked to where that
 * weight comes from. The grams are what's counted; what she typed is kept
 * beside them as the item's `measure`. Also here: useMeasures, the one query
 * for a set of foods' measures, shared with MealPrepPlan.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getMeasures } from './api';
import { formatAmount } from './nutrientMath';
import { parseAmount, unitName } from './measureMath';
import type { MealItem, Measure } from './types';
import styles from './Nutrition.module.css';

/** Each food's measures, keyed by USDA id, fetched once per set of foods. */
export function useMeasures(fdcIds: number[]): Record<string, Measure[]> | undefined {
  const ids = [...new Set(fdcIds)].sort((a, b) => a - b);
  const query = useQuery({
    queryKey: ['nutrition', 'measures', ids],
    queryFn: ({ signal }) => getMeasures(ids, signal),
    enabled: ids.length > 0,
    staleTime: Infinity,
  });
  return query.data?.measures;
}

export function AmountInput({
  item,
  measures,
  onChange,
}: {
  item: MealItem;
  measures: Measure[] | undefined;
  onChange: (grams: number, measure: string | undefined) => void;
}) {
  // The box shows what she typed; it follows the item only when that changes from outside (a save, a reset),
  // never from her own typing, so "1." isn't snapped back to "1" mid-word.
  const shown = item.measure ?? String(item.grams);
  const [text, setText] = useState(shown);
  const emitted = useRef(shown);
  useEffect(() => {
    if (shown !== emitted.current) setText(shown);
    emitted.current = shown;
  }, [shown]);

  // Read the text every keystroke; a good reading updates the item, a bad one only shows why.
  const parsed = parseAmount(text, measures);
  const typedMeasure = 'grams' in parsed && parsed.measure ? parsed.measure : undefined;
  const update = (next: string) => {
    setText(next);
    const reading = parseAmount(next, measures);
    if ('grams' in reading) {
      emitted.current = reading.measure ? reading.text : String(reading.grams);
      onChange(reading.grams, reading.measure ? reading.text : undefined);
    }
  };
  const units = [...new Set((measures ?? []).map((measure) => unitName(measure.unit)))];

  return (
    <span className={styles.amount}>
      <span className={styles.amountRow}>
        <input
          className={`${styles.gramsInput} ${styles.amountInput}`}
          aria-label={`${item.label} amount — grams, or a measure like 1.5 cup`}
          title={units.length ? `Grams, or: ${units.join(', ')}` : 'Grams'}
          value={text}
          onChange={(event) => update(event.target.value)}
        />
        {typedMeasure ? (
          <a
            className={styles.gramsUnit}
            href={typedMeasure.url}
            target="_blank"
            rel="noreferrer"
            title={`${typedMeasure.label} = ${formatAmount(typedMeasure.grams)} g — ${typedMeasure.source}`}
          >
            = {formatAmount(item.grams)} g
          </a>
        ) : (
          <span className={styles.gramsUnit}>g</span>
        )}
      </span>
      {'error' in parsed && text.trim() ? <span className={styles.amountError}>{parsed.error}</span> : null}
    </span>
  );
}
