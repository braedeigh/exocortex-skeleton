import { useEffect, useRef, useState } from 'react';
import { ecoRecipeSourcing, ecoTx } from './ecoMatch';
import { walkRecipeChain } from './recipeHelpers';
import { Section } from './Section';
import type { EcoSource, Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipeDetailViewProps {
  recipe: Recipe;
  allRecipes: Recipe[];
  sources: EcoSource[];
  onBack: () => void;
  onEdit: () => void;
  onSendToList: () => void;
  onViewRecipe: (id: string) => void;
  saveMyNotes: (id: string, notes: string) => Promise<unknown>;
}

/** Port of renderRecipeDetailInto — read view with the sourcing card
 * ("Where it comes from"), autosaving "My notes", and the past-versions chain. */
export function RecipeDetailView({
  recipe,
  allRecipes,
  sources,
  onBack,
  onEdit,
  onSendToList,
  onViewRecipe,
  saveMyNotes,
}: RecipeDetailViewProps) {
  const [myNotes, setMyNotes] = useState(recipe.my_notes || '');
  const [notesStatus, setNotesStatus] = useState('');
  const lastSaved = useRef(recipe.my_notes || '');

  // Follow server updates unless there are local unsaved edits.
  useEffect(() => {
    if (myNotes === lastSaved.current && (recipe.my_notes || '') !== lastSaved.current) {
      setMyNotes(recipe.my_notes || '');
      lastSaved.current = recipe.my_notes || '';
    }
  }, [recipe.my_notes, myNotes]);

  async function persistNotes() {
    if (myNotes === lastSaved.current) return;
    setNotesStatus('saving…');
    try {
      await saveMyNotes(recipe.id, myNotes);
      lastSaved.current = myNotes;
      setNotesStatus('saved');
    } catch {
      setNotesStatus('save failed');
    }
  }

  const metaBits: string[] = [];
  if (recipe.servings) metaBits.push(`${recipe.servings} servings`);
  if (recipe.prep_min) metaBits.push(`${recipe.prep_min} min prep`);
  if (recipe.cook_min) metaBits.push(`${recipe.cook_min} min cook`);

  const hasSections = Array.isArray(recipe.sections) && recipe.sections.length > 0;
  const sourcing = ecoRecipeSourcing(recipe, sources);
  const chain = walkRecipeChain(recipe, allRecipes);

  return (
    <div style={{ marginBottom: 20 }}>
      <div className={styles.rowFlex} style={{ marginBottom: 14 }}>
        <button type="button" className={styles.mutedBtn} onClick={onBack}>
          ← Back
        </button>
        <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center', minWidth: 120 }}>
          <button
            type="button"
            className={styles.greenBtn}
            title="Pick ingredients (the ones you need are pre-checked) and add to your grocery list"
            onClick={onSendToList}
          >
            Send to list
          </button>
        </div>
        <button
          type="button"
          className={styles.mutedBtn}
          style={{ color: 'var(--text)', borderColor: 'var(--accent)', fontWeight: 600 }}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>

      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{recipe.name}</div>
      {metaBits.length ? (
        <div className={styles.muted13} style={{ marginBottom: 6 }}>
          {metaBits.join(' · ')}
        </div>
      ) : null}
      <div style={{ marginBottom: 18 }}>
        {(recipe.tags || []).map((t) => (
          <span key={t} className={styles.badge} style={{ marginRight: 4 }}>
            {t}
          </span>
        ))}
        {recipe.source_url ? (
          <a href={recipe.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ongoing)', fontSize: 12, textDecoration: 'none' }}>
            source ↗
          </a>
        ) : null}
      </div>

      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 16 }}>Ingredients</div>
      <ul style={{ margin: '0 0 18px 18px', padding: 0 }}>
        {(recipe.ingredients || []).map((i, idx) => {
          const qty = (i.qty || '').trim();
          const item = (i.item || '').trim();
          return (
            <li key={idx} style={{ marginBottom: 4 }}>
              {qty ? (
                <>
                  {item} — <span style={{ color: 'var(--text-muted)' }}>{qty}</span>
                </>
              ) : (
                item
              )}
              {i.note ? <span className={styles.muted12}> ({i.note})</span> : null}
            </li>
          );
        })}
      </ul>

      {sourcing.total ? (
        <div style={{ margin: '0 0 18px' }}>
          <Section
            title="Where it comes from"
            defaultOpen
            badge={
              <span className={styles.muted12} style={{ fontWeight: 400 }}>
                traced {sourcing.traced.length}/{sourcing.total}
              </span>
            }
          >
            <div style={{ padding: '0 0 12px' }}>
              {sourcing.traced.length ? (
                sourcing.traced.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13 }}>
                    <span
                      style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: ecoTx(t.source).color, flex: 'none' }}
                    />
                    <span style={{ flex: 1 }}>{t.ing.item}</span>
                    <span className={styles.muted12}>{t.source.name}</span>
                  </div>
                ))
              ) : (
                <div className={styles.muted13}>Nothing traced yet — place these foods on the map.</div>
              )}
              {sourcing.place.length ? (
                <div className={styles.muted12} style={{ marginTop: 8 }}>
                  Not yet traced: {sourcing.place.map((p) => p.ing.item).join(', ')}
                </div>
              ) : null}
              {sourcing.pantry.length ? (
                <div className={styles.muted12} style={{ marginTop: 4, opacity: 0.7 }}>
                  + {sourcing.pantry.length} pantry staple{sourcing.pantry.length === 1 ? '' : 's'} (not traced)
                </div>
              ) : null}
              {/* Deep-link to the Ecosystem tab with this recipe selected (old
                  switchTab(event,'ecosystem',{recipe:id})). The React ecosystem
                  page reads ?recipe= when it lands. */}
              <a
                href={`/ecosystem?recipe=${encodeURIComponent(recipe.id)}`}
                className={styles.mutedBtn}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginTop: 12,
                  color: 'var(--accent)',
                  borderColor: 'var(--accent)',
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                View on map →
              </a>
            </div>
          </Section>
        </div>
      ) : null}

      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 16 }}>Instructions</div>
      {hasSections ? (
        recipe.sections!.map((sec, si) => (
          <div key={si}>
            <div style={{ fontWeight: 700, fontSize: 14, margin: '14px 0 6px', color: 'var(--accent)' }}>{sec.title || ''}</div>
            <ol style={{ margin: '0 0 6px 18px', padding: 0 }}>
              {(sec.steps || []).map((s, i) => (
                <li key={i} style={{ marginBottom: 8, paddingLeft: 6, lineHeight: 1.55 }}>
                  {s}
                </li>
              ))}
            </ol>
          </div>
        ))
      ) : (
        <ol style={{ margin: '0 0 18px 18px', padding: 0 }}>
          {(recipe.instructions || []).map((s, i) => (
            <li key={i} style={{ marginBottom: 8, paddingLeft: 6, lineHeight: 1.55 }}>
              {s}
            </li>
          ))}
        </ol>
      )}

      {recipe.notes ? (
        <div style={{ fontStyle: 'italic', color: 'var(--text-muted)', fontSize: 13, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
          {recipe.notes}
        </div>
      ) : null}

      <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)', marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>My notes</div>
          <div className={styles.muted12}>{notesStatus}</div>
        </div>
        <textarea
          className={styles.textarea}
          style={{ width: '100%', maxHeight: 300, overflowY: 'auto' }}
          rows={4}
          placeholder="What you tweaked, how it turned out, who liked it…"
          value={myNotes}
          onChange={(e) => {
            setMyNotes(e.target.value);
            setNotesStatus('unsaved…');
            // auto-grow like the old autoGrow(el)
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 300)}px`;
          }}
          onBlur={() => void persistNotes()}
        />
      </div>

      {chain.length ? (
        <div style={{ marginTop: 18 }}>
          <Section title="Past versions" badge={<span className={styles.muted12}>({chain.length})</span>}>
            <div style={{ paddingTop: 8 }}>
              {chain.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
                  <span className={styles.muted12} style={{ minWidth: 90 }}>{r.created || '—'}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>{r.name || '(untitled)'}</span>
                  <button type="button" className={styles.smallBtn} onClick={() => onViewRecipe(r.id)}>
                    View
                  </button>
                </div>
              ))}
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  );
}
