import { useState } from 'react';
import { saveRecipe, saveRecipeAsVariant } from './api';
import { draftFromRecipe, recipeFromDraft } from './recipeDraft';
import { RecipeFormFields } from './RecipeFormFields';
import type { Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipeEditViewProps {
  recipe: Recipe;
  serverDate?: string;
  onCancel: () => void;
  /** in-place save landed */
  onSaved: () => void;
  /** variant save landed — jump to the new variant's detail page */
  onSavedVariant: (newId: string) => void;
  onConfirmDelete: (id: string, name: string) => void;
  onError: (message: string) => void;
}

/** Port of the in-page recipe editor (_renderRecipeEditInto) — same form as
 * the import review plus drag/▲▼ step reorder, My notes, Delete, and the
 * Save / Save-new-version pair (top and bottom). */
export function RecipeEditView({
  recipe,
  serverDate,
  onCancel,
  onSaved,
  onSavedVariant,
  onConfirmDelete,
  onError,
}: RecipeEditViewProps) {
  const [draft, setDraft] = useState(() => draftFromRecipe(recipe));

  async function save() {
    const out = recipeFromDraft(draft);
    if (!out.name) {
      onError('Recipe needs a name.');
      return;
    }
    try {
      const res = await saveRecipe(out);
      if (res?.error) {
        onError(`Save failed: ${res.error}`);
        return;
      }
    } catch (e) {
      onError(`Save failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    onSaved();
  }

  async function saveVariant() {
    const out = recipeFromDraft(draft);
    if (!out.name) {
      onError('Recipe needs a name.');
      return;
    }
    // Auto-append a date suffix if the name doesn't already differ.
    if (out.name.trim() === (recipe.name || '').trim()) {
      const today = serverDate || new Date().toISOString().slice(0, 10);
      out.name = `${out.name} (modified ${today})`;
    }
    try {
      const res = await saveRecipeAsVariant(out);
      if (res?.error) {
        onError(`Save failed: ${res.error}`);
        return;
      }
      onSavedVariant(res.id);
    } catch (e) {
      onError(`Save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const saveButtons = (
    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className={styles.mutedBtn} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className={styles.ongoingBtn} title="Overwrite this recipe in place" onClick={() => void save()}>
        Save
      </button>
      <button
        type="button"
        className={styles.primaryBtn}
        title="Archive current and create a new version"
        onClick={() => void saveVariant()}
      >
        Save new version
      </button>
    </div>
  );

  return (
    <div style={{ marginBottom: 20 }}>
      <div className={styles.rowFlex} style={{ marginBottom: 14 }}>
        <span className={styles.muted12}>Editing</span>
        {saveButtons}
      </div>

      <RecipeFormFields draft={draft} onChange={setDraft} reorderableSteps showMyNotes />

      <div className={styles.rowFlex} style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <button
          type="button"
          className={`${styles.mutedBtn}`}
          style={{ color: 'var(--red)', borderColor: 'var(--red)', fontWeight: 600 }}
          onClick={() => onConfirmDelete(recipe.id, recipe.name || 'recipe')}
        >
          Delete
        </button>
        {saveButtons}
      </div>
    </div>
  );
}
