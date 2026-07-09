import { useState } from 'react';
import { saveRecipe } from './api';
import { Modal } from './Modal';
import { draftFromRecipe, recipeFromDraft } from './recipeDraft';
import { RecipeFormFields } from './RecipeFormFields';
import type { Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipeImportModalProps {
  filename: string;
  recipe: Recipe;
  onClose: () => void;
  onSaved: () => void;
  onDiscard: (filename: string) => void;
  onError: (message: string) => void;
}

/** Port of the "Review parsed recipe" overlay — full edit of the parse before
 * it lands in recipes.json. */
export function RecipeImportModal({ filename, recipe, onClose, onSaved, onDiscard, onError }: RecipeImportModalProps) {
  const [draft, setDraft] = useState(() => draftFromRecipe(recipe));

  async function save() {
    const out = recipeFromDraft(draft);
    if (!out.name) {
      onError('Recipe needs a name.');
      return;
    }
    try {
      const res = await saveRecipe(out, filename);
      if (res?.error) {
        onError(`Save failed: ${res.error}`);
        return;
      }
    } catch (e) {
      onError(`Save failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Modal
      title="Review parsed recipe"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button type="button" className={styles.ongoingBtn} onClick={() => void save()}>
            Save recipe
          </button>
          <button
            type="button"
            className={styles.mutedBtn}
            onClick={() => {
              if (window.confirm('Discard this parsed recipe? The original URL/image file is kept.')) {
                onDiscard(filename);
                onClose();
              }
            }}
          >
            Discard
          </button>
        </>
      }
    >
      <RecipeFormFields draft={draft} onChange={setDraft} />
    </Modal>
  );
}
