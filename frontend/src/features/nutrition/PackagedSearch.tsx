/**
 * PackagedSearch.tsx — add a packaged food to a meal: by name, by brand, by
 * typing the barcode number, or by scanning it with the camera.
 *
 * The products are USDA's Branded Foods: what each maker prints on its label,
 * as USDA copies it (fdcdb.py). So a result says whose figures they are, and
 * how few: a label usually gives 10–15 nutrients, and the rest count as
 * unknown on the page, never as zero (nutrition.totals `missing`). A picked
 * product joins the meal at one label serving when the label gives it in
 * grams, else at 100 g; either way the weight is marked a guess until weighed.
 *
 * Shown by the add-a-food search in Meals (./NutritionPage.tsx `FoodSearch`)
 * when "Packaged" is on. Data: GET /api/nutrition/packaged (routes/nutrition.py).
 * The camera is ./BarcodeScanner.tsx, loaded only when opened.
 *
 * Prompt: "no packaged or branded food support, and no barcode lookup" — "yeah sure".
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { searchPackaged } from './api';
import type { MealItem, PackagedFood } from './types';
import styles from './Nutrition.module.css';

// The camera and its barcode library download only when "Scan" is tapped.
const BarcodeScanner = lazy(() => import('./BarcodeScanner'));

export function PackagedSearch({ onPick }: { onPick: (item: MealItem) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scanning, setScanning] = useState(false);
  // A debounce: search 300 ms after the typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['nutrition', 'packaged', debounced],
    queryFn: ({ signal }) => searchPackaged(debounced, signal),
    enabled: debounced.length >= 2,
  });
  const isBarcode = /^[\d\s-]{8,}$/.test(debounced);

  // A scanned code goes straight into the box and is looked up at once.
  const scanned = useCallback((code: string) => {
    setScanning(false);
    setText(code);
    setDebounced(code);
  }, []);

  return (
    <div className={styles.search}>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="Name, brand, or barcode number"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="button" className={styles.chip} onClick={() => setScanning(!scanning)} aria-pressed={scanning}>
          Scan
        </button>
      </div>
      {scanning ? (
        <Suspense fallback={<p className={styles.muted}>Opening the camera…</p>}>
          <BarcodeScanner onCode={scanned} onClose={() => setScanning(false)} />
        </Suspense>
      ) : null}
      {results.isError ? <p className={styles.error}>{(results.error as Error).message}</p> : null}
      {debounced.length >= 2 && results.data ? (
        <ul className={styles.results}>
          {results.data.foods.map((food) => (
            <li key={food.fdc_id}>
              <button
                type="button"
                className={styles.result}
                onClick={() => {
                  onPick(mealItem(food));
                  setText('');
                }}
              >
                <span>
                  {food.description}
                  <span className={styles.resultDetail}>
                    {[brandOf(food), servingOf(food), `barcode ${food.gtin_upc}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={styles.resultTag}>label · {food.nutrient_count} nutrients</span>
              </button>
            </li>
          ))}
          {!results.data.foods.length ? (
            <li className={styles.muted}>
              {isBarcode
                ? `USDA has no packaged food under barcode ${debounced}.`
                : 'No packaged food by that name or brand.'}
            </li>
          ) : null}
        </ul>
      ) : null}
      <p className={styles.muted}>
        Packaged foods carry the maker’s label figures as USDA lists them, not USDA’s own lab analysis. A label
        gives 10–15 nutrients, and the rest show as unknown.
      </p>
    </div>
  );
}

// A product as a meal item: named with its brand, one label serving when that's in grams.
function mealItem(food: PackagedFood): MealItem {
  const brand = brandOf(food);
  const label = brand && !food.description.toLowerCase().includes(brand.toLowerCase())
    ? `${brand} ${food.description}`
    : food.description;
  const grams = food.serving_size_unit === 'g' && food.serving_size ? food.serving_size : 100;
  return { label, fdc_id: food.fdc_id, grams, grams_guessed: true };
}

function brandOf(food: PackagedFood): string {
  return food.brand_name || food.brand_owner || '';
}

// "1/2 cup (40 g)", or just the size when the label gives no household words.
function servingOf(food: PackagedFood): string {
  if (!food.serving_size) return food.household_serving ?? '';
  const size = `${food.serving_size} ${food.serving_size_unit ?? ''}`.trim();
  return food.household_serving && !food.household_serving.includes(String(food.serving_size))
    ? `${food.household_serving} (${size})`
    : food.household_serving || size;
}
