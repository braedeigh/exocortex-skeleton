/**
 * RecipeDetailView.tsx — one recipe, read view, on the Kitchen tab.
 *
 * What this file does: draws the recipe (meta, ingredients, instructions),
 * "Where it comes from", her autosaving "My notes", and past versions.
 * Where it comes from follows each ingredient's food along its real links to
 * map sources (ecoRecipeSourcing, features/ecosystem/ecoMatch.ts) and opens
 * with one line — "3 of 9 traced" (traceSummary.ts). Each traced ingredient's
 * name opens its food's page in the Food area, and each source name opens that
 * source on the map. Untraced ones are listed with the closest-named source
 * as a hint only, plus a "Request linking" button (ecosystem/RequestLinkButton)
 * that queues the food for research — it doesn't link anything; requestState.ts
 * says whether it's already asked. KitchenPage.tsx passes in the recipe, the
 * map's sources, the recipe with its lines resolved to foods (eco_recipes) and
 * the open requests (eco_requested). Below it, for her only, "Nutrients per
 * serving" (./RecipeNutrients.tsx): one serving against her daily targets,
 * and how each line was counted.
 */
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ecoRecipeSourcing } from '../ecosystem/ecoMatch';
import { RequestLinkButton } from '../ecosystem/RequestLinkButton';
import type { EcoRecipe } from '../ecosystem/types';
import { SourceDot, SourceLink } from './ComesFrom';
import { walkRecipeChain } from './recipeHelpers';
import { RecipeNutrients } from './RecipeNutrients';
import { Section } from './Section';
import { isLinkRequested } from './requestState';
import { traceSummary } from './traceSummary';
import type { EcoRequested, EcoSource, Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipeDetailViewProps {
  recipe: Recipe;
  allRecipes: Recipe[];
  sources: EcoSource[];
  /** The same recipe with each line resolved to its food — what tracing follows. */
  ecoRecipe: EcoRecipe | null;
  /** Foods already queued for research, so their button reads "Requested". */
  ecoRequested?: EcoRequested;
  /** A request went through — refetch so eco_requested catches up. */
  onRequested?: () => void;
  onRequestError?: (message: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onSendToList: () => void;
  onViewRecipe: (id: string) => void;
  saveMyNotes: (id: string, notes: string) => Promise<unknown>;
  /** logged-out visitor — hide Edit/Send-to-list and the "My notes" editor
   * (autosaving write surface); the note text still shows read-only if set. */
  isPublic?: boolean;
}

/** Port of renderRecipeDetailInto — read view with the sourcing card
 * ("Where it comes from"), autosaving "My notes", and the past-versions chain. */
export function RecipeDetailView({
  recipe,
  allRecipes,
  sources,
  ecoRecipe,
  ecoRequested,
  onRequested,
  onRequestError,
  onBack,
  onEdit,
  onSendToList,
  onViewRecipe,
  saveMyNotes,
  isPublic = false,
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
  // Where it comes from: each line's food, followed along its links to the map.
  const sourcing = ecoRecipeSourcing(ecoRecipe, sources);
  const summary = traceSummary(sourcing);
  const chain = walkRecipeChain(recipe, allRecipes);

  return (
    <div style={{ marginBottom: 20 }}>
      <div className={styles.rowFlex} style={{ marginBottom: 14 }}>
        <button type="button" className={styles.mutedBtn} onClick={onBack}>
          ← Back
        </button>
        {!isPublic ? (
          <>
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
          </>
        ) : null}
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
                {summary.text}
              </span>
            }
          >
            <div style={{ padding: '0 0 12px' }}>
              {/* Traced ingredients: the food's name opens its page, each source opens on the map.
                  A visitor has no food pages, so there the food name is plain text. */}
              {sourcing.traced.length ? (
                sourcing.traced.map((t, i) => (
                  <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 10px', fontSize: 14 }}>
                    <span style={{ flex: '1 1 140px' }}>
                      <FoodName item={t.ing.item || ''} foodName={t.ing.food_name} isPublic={isPublic} />
                    </span>
                    {t.sources.map((source) => (
                      <span key={source.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <SourceDot source={source} />
                        <SourceLink source={source} />
                      </span>
                    ))}
                  </div>
                ))
              ) : (
                <div className={styles.muted13}>Nothing traced yet.</div>
              )}
              {/* Untraced ingredients: each on its own row, with the closest-named source as a
                  hint only — a guess from shared words, never drawn as a trace — and, for her,
                  a button that queues the food for research (by id, or by name if uncataloged). */}
              {sourcing.place.length ? (
                <div style={{ marginTop: 10 }}>
                  <div className={styles.muted12} style={{ fontWeight: 700 }}>
                    Not traced yet
                  </div>
                  {sourcing.place.map((p, i) => (
                    <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 10px', fontSize: 14, minHeight: 40 }}>
                      <span style={{ flex: '1 1 140px' }}>
                        <FoodName item={p.ing.item || ''} foodName={p.ing.food_name} isPublic={isPublic} />
                      </span>
                      {p.suggestion ? <span className={styles.muted12}>looks like: {p.suggestion.name}?</span> : null}
                      {p.ing.food_id == null ? <span className={styles.muted12}>not in your food catalog</span> : null}
                      {isPublic ? null : (
                        <RequestLinkButton
                          foodId={p.ing.food_id ?? null}
                          foodName={p.ing.food_name || p.ing.item || ''}
                          requested={isLinkRequested(ecoRequested, p.ing.food_id, p.ing.food_name || p.ing.item || '')}
                          from={`recipe:${recipe.id}`}
                          onRequested={onRequested}
                          onError={onRequestError}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              {sourcing.pantry.length ? (
                <div className={styles.muted12} style={{ marginTop: 4, opacity: 0.7 }}>
                  + {sourcing.pantry.length} pantry staple{sourcing.pantry.length === 1 ? '' : 's'} (not traced)
                </div>
              ) : null}
              {/* Open this recipe on the Food area's map: /food reads ?recipe= when it lands. */}
              <a
                href={`/food?recipe=${encodeURIComponent(recipe.id)}`}
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

      {/* What a serving gives against her targets — her own numbers, so not for a visitor. */}
      {!isPublic ? <RecipeNutrients recipeId={recipe.id} /> : null}

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

      {!isPublic ? (
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
      ) : recipe.my_notes ? (
        // Read-only view: show the note text without the autosaving editor.
        <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)', marginTop: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>My notes</div>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{recipe.my_notes}</div>
        </div>
      ) : null}

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

/** An ingredient's name that opens its food's page in the Food area — keyed by
 * the catalog food's name when the line resolved to one, else the line as
 * written (the page still opens and says it isn't in the catalog yet). */
function FoodName({ item, foodName, isPublic }: { item: string; foodName?: string | null; isPublic: boolean }) {
  if (isPublic) return <>{item}</>;
  return (
    <Link
      to="/food/foods/$name"
      params={{ name: foodName || item }}
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: 40, color: 'var(--text)', textDecoration: 'underline dotted' }}
      title="This food's page"
    >
      {item}
    </Link>
  );
}
