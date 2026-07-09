/**
 * ThisWeekMealCard.tsx — the "This Week's Meal" protein/veg cluster picker +
 * weekly grocery-list generation. Port of kitchen.js renderThisWeekMealHTML /
 * setMealProtein / toggleMealVeg / toggleMealSalad / generateWeeklyList.
 *
 * PARITY NOTE: the old render loop stopped mounting this widget ("its role is
 * now handled by per-recipe choice groups in the Recipes section") but the
 * code + endpoints remain live. Ported and exported for completeness — not
 * mounted on KitchenPage, matching the old tab.
 */
import { useState } from 'react';
import {
  generateWeeklyList,
  setMealProtein,
  setMealVegetables,
  toggleMealSalad,
  type GenerateListResult,
} from './api';
import type { KitchenData } from './types';
import styles from './kitchen.module.css';

export interface ThisWeekMealCardProps {
  data: KitchenData;
  onError: (message: string) => void;
  invalidate: () => void;
}

export function ThisWeekMealCard({ data, onError, invalidate }: ThisWeekMealCardProps) {
  const [genResult, setGenResult] = useState<GenerateListResult | null>(null);

  const md = data.meal_defaults || {};
  const mp = md.meal_prep || {};
  if (!mp.protein_rotation || !mp.vegetable_pool) return null; // not configured

  const tw = mp.this_week || {};
  const protein = tw.protein || '';
  const pickedVeg = tw.vegetables || [];
  const always = mp.always_vegetables || [];
  const grain = mp.grain || '';
  const lb = data.kitchen_last_bought || {};
  const saladOn = !!(md.side_salad && md.side_salad.enabled_this_week);
  const saladIngs = (md.side_salad && md.side_salad.ingredients) || [];

  let rotationHint = '';
  if (mp.protein_rotation.length >= 2) {
    const dated = mp.protein_rotation
      .map((p) => ({ p, d: lb[p] || '' }))
      .sort((a, b) => (b.d > a.d ? 1 : b.d < a.d ? -1 : 0));
    if (dated[0].d) rotationHint = `(last: ${dated[0].p} ${dated[0].d})`;
  }

  async function run(fn: () => Promise<unknown>) {
    setGenResult(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Request failed');
    }
    invalidate();
  }

  async function toggleVeg(name: string) {
    let veg = pickedVeg.slice();
    const idx = veg.indexOf(name);
    if (idx >= 0) veg.splice(idx, 1);
    else {
      veg.push(name);
      if (veg.length > 2) veg = veg.slice(-2); // keep most recent 2
    }
    await run(() => setMealVegetables(veg));
  }

  async function generate() {
    try {
      const res = await generateWeeklyList();
      if (res.error) {
        onError(`Failed: ${res.error}`);
        return;
      }
      setGenResult(res);
    } catch (e) {
      onError(`Failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    invalidate();
  }

  let resultMsg = '';
  if (genResult) {
    const parts: string[] = [];
    if (genResult.added?.length) parts.push(`Added: ${genResult.added.join(', ')}`);
    if (genResult.skipped_in_pantry?.length) parts.push(`In pantry: ${genResult.skipped_in_pantry.join(', ')}`);
    if (genResult.skipped_already_on_list?.length)
      parts.push(`Already on list: ${genResult.skipped_already_on_list.join(', ')}`);
    resultMsg = parts.length ? parts.join(' · ') : 'Nothing to add — list already covers this week.';
  }

  return (
    <div className={styles.card} style={{ border: '1px solid var(--border)', padding: '12px 16px', marginBottom: 20 }}>
      <div className={styles.rowFlex} style={{ padding: '4px 0 10px' }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>This Week&apos;s Meal</span>
        {tw.week_of ? <span className={styles.muted12}>week of {tw.week_of}</span> : null}
      </div>

      <div className={styles.rowFlex} style={{ margin: '6px 0' }}>
        <span className={styles.muted12} style={{ minWidth: 54 }}>Protein</span>
        {mp.protein_rotation.map((p) => {
          const sel = p === protein;
          return (
            <button
              key={p}
              type="button"
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: `1px solid ${sel ? 'var(--green)' : 'var(--border)'}`,
                background: sel ? 'rgba(58,158,140,0.15)' : 'none',
                color: 'var(--text)',
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: sel ? 600 : 400,
                minHeight: 40,
              }}
              onClick={() => void run(() => setMealProtein(p))}
            >
              {p}
            </button>
          );
        })}
        {rotationHint ? <span className={styles.muted12}>{rotationHint}</span> : null}
      </div>

      <div className={styles.rowFlex} style={{ margin: '6px 0', gap: 6 }}>
        <span className={styles.muted12} style={{ minWidth: 54 }}>Base</span>
        {[grain, ...always].filter(Boolean).map((b) => (
          <span key={b} style={{ padding: '4px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', fontSize: 12, color: 'var(--text-muted)' }}>
            {b}
          </span>
        ))}
      </div>

      <div style={{ margin: '10px 0' }}>
        <div className={styles.rowFlex} style={{ marginBottom: 6 }}>
          <span className={styles.muted12} style={{ minWidth: 54 }}>Pick 2</span>
          <span className={styles.muted12}>({pickedVeg.length}/2)</span>
        </div>
        <div className={styles.chipWrap} style={{ marginBottom: 0 }}>
          {mp.vegetable_pool.map((v) => {
            const sel = pickedVeg.includes(v);
            return (
              <button
                key={v}
                type="button"
                style={{
                  padding: '6px 12px',
                  borderRadius: 14,
                  border: `1px solid ${sel ? 'var(--green)' : 'var(--border)'}`,
                  background: sel ? 'rgba(58,158,140,0.15)' : 'none',
                  color: 'var(--text)',
                  fontSize: 12,
                  cursor: 'pointer',
                  minHeight: 40,
                }}
                onClick={() => void toggleVeg(v)}
              >
                {sel ? '✓ ' : ''}
                {v}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ margin: '10px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, minHeight: 40 }}>
          <input type="checkbox" checked={saladOn} onChange={(e) => void run(() => toggleMealSalad(e.target.checked))} />
          <span>Side salad this week</span>
          {saladIngs.length ? <span className={styles.muted12}>({saladIngs.join(', ')})</span> : null}
        </label>
      </div>

      <div className={styles.rowFlex} style={{ marginTop: 12, gap: 10 }}>
        <button type="button" className={styles.greenBtn} onClick={() => void generate()}>
          Update grocery list →
        </button>
        <span className={styles.muted12}>Adds missing items, checks pantry for staples</span>
      </div>

      {resultMsg ? (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            background: 'rgba(58,158,140,0.08)',
            border: '1px solid rgba(58,158,140,0.3)',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {resultMsg}
        </div>
      ) : null}
    </div>
  );
}
