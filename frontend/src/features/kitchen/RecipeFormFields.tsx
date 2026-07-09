import { useRef } from 'react';
import type { RecipeDraft } from './recipeDraft';
import { moveInstruction } from './recipeDraft';
import {
  RECIPE_CATEGORIES,
  RECIPE_CATEGORY_LABELS,
  STOCKING_STATUSES,
  ingStockingStatus,
  ingStoreCategory,
} from './recipeHelpers';
import styles from './kitchen.module.css';

export interface RecipeFormFieldsProps {
  draft: RecipeDraft;
  onChange: (next: RecipeDraft) => void;
  /** the in-page editor gets drag + ▲▼ step reorder; the import review doesn't */
  reorderableSteps?: boolean;
  /** the in-page editor also edits "My notes" */
  showMyNotes?: boolean;
}

/** Shared body of the parsed-recipe review modal and the in-page recipe
 * editor: name/servings/prep/cook, ingredient rows (item · qty · store
 * section · stocking status · note · ×), instruction steps, tags, notes. */
export function RecipeFormFields({ draft, onChange, reorderableSteps = false, showMyNotes = false }: RecipeFormFieldsProps) {
  const dragIdx = useRef<number | null>(null);

  const patch = (p: Partial<RecipeDraft>) => onChange({ ...draft, ...p });

  function patchIngredient(i: number, field: string, value: string) {
    const next = draft.ingredients.map((ing, idx) => (idx === i ? { ...ing, [field]: value } : ing));
    patch({ ingredients: next });
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: 'var(--text-muted)',
    marginBottom: 10,
  };

  const stepCount = draft.instructions.length;

  return (
    <>
      <label style={labelStyle}>
        Name
        <input
          type="text"
          className={styles.textInput}
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Servings
          <input type="number" min={1} className={styles.textInput} value={draft.servings} onChange={(e) => patch({ servings: e.target.value })} />
        </label>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Prep (min)
          <input type="number" min={0} className={styles.textInput} value={draft.prep} onChange={(e) => patch({ prep: e.target.value })} />
        </label>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Cook (min)
          <input type="number" min={0} className={styles.textInput} value={draft.cook} onChange={(e) => patch({ cook: e.target.value })} />
        </label>
      </div>

      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 15 }}>Ingredients</div>
      {draft.ingredients.map((ing, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            type="text"
            className={styles.textInput}
            style={{ flex: 2, minWidth: 120, fontSize: 13 }}
            placeholder="ingredient"
            value={ing.item || ''}
            onChange={(e) => patchIngredient(i, 'item', e.target.value)}
          />
          <input
            type="text"
            className={styles.textInput}
            style={{ flex: 1, minWidth: 80, fontSize: 13 }}
            placeholder="qty"
            value={ing.qty || ''}
            onChange={(e) => patchIngredient(i, 'qty', e.target.value)}
          />
          <select
            className={styles.select}
            title="Store section"
            value={ingStoreCategory(ing)}
            onChange={(e) => patchIngredient(i, 'category', e.target.value)}
          >
            {RECIPE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RECIPE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            title="Send behavior"
            value={ingStockingStatus(ing)}
            onChange={(e) => patchIngredient(i, 'stocking_status', e.target.value)}
          >
            {STOCKING_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            className={styles.textInput}
            style={{ flex: 1, minWidth: 80, fontSize: 12 }}
            placeholder="note"
            value={ing.note || ''}
            onChange={(e) => patchIngredient(i, 'note', e.target.value)}
          />
          <button
            type="button"
            className={styles.deleteBtn}
            style={{ color: 'var(--red)', fontSize: 18 }}
            title="Remove ingredient"
            onClick={() => patch({ ingredients: draft.ingredients.filter((_, idx) => idx !== i) })}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.smallBtn}
        style={{ borderStyle: 'dashed', marginBottom: 14 }}
        onClick={() =>
          patch({ ingredients: [...draft.ingredients, { item: '', qty: '', category: 'other', note: '' }] })
        }
      >
        + Add ingredient
      </button>

      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 15 }}>Instructions</div>
      {reorderableSteps && Array.isArray(draft.base.sections) && draft.base.sections.length ? (
        <div
          className={styles.muted12}
          style={{
            background: 'rgba(124,92,191,0.08)',
            border: '1px dashed var(--accent)',
            borderRadius: 6,
            padding: '8px 10px',
            marginBottom: 8,
          }}
        >
          This recipe has step <b>sections</b> (shown grouped on the detail page). The flat list below is the raw
          steps — editing it won&apos;t restructure the sections, and the grouped view keeps its own copy. In-form
          section editing is coming soon.
        </div>
      ) : null}
      {draft.instructions.map((step, i) => (
        <div
          key={i}
          draggable={reorderableSteps}
          onDragStart={(e) => {
            if (!reorderableSteps) return;
            dragIdx.current = i;
            e.dataTransfer.effectAllowed = 'move';
            e.currentTarget.style.opacity = '0.4';
          }}
          onDragOver={(e) => {
            if (!reorderableSteps) return;
            e.preventDefault();
            if (dragIdx.current !== i) e.currentTarget.style.borderTop = '2px solid var(--accent)';
          }}
          onDragLeave={(e) => {
            e.currentTarget.style.borderTop = '';
          }}
          onDragEnd={(e) => {
            dragIdx.current = null;
            e.currentTarget.style.opacity = '';
          }}
          onDrop={(e) => {
            if (!reorderableSteps) return;
            e.preventDefault();
            e.currentTarget.style.borderTop = '';
            if (dragIdx.current == null || dragIdx.current === i) return;
            patch({ instructions: moveInstruction(draft.instructions, dragIdx.current, i) });
            dragIdx.current = null;
          }}
          style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 6, padding: 2 }}
        >
          {reorderableSteps ? (
            <span
              title="Drag to reorder"
              style={{ paddingTop: 8, color: 'var(--text-muted)', cursor: 'grab', fontSize: 14, userSelect: 'none', letterSpacing: '-2px' }}
            >
              &#8942;&#8942;
            </span>
          ) : null}
          <span style={{ paddingTop: 10, fontSize: 13, color: 'var(--text-muted)', width: 24, textAlign: 'right' }}>{i + 1}.</span>
          <textarea
            className={styles.textarea}
            rows={2}
            style={{ flex: 1, fontSize: 13 }}
            value={step}
            aria-label={`Step ${i + 1}`}
            onChange={(e) =>
              patch({ instructions: draft.instructions.map((s, idx) => (idx === i ? e.target.value : s)) })
            }
          />
          {reorderableSteps ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 4 }}>
              <button
                type="button"
                title="Move up"
                disabled={i === 0}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: i === 0 ? 'not-allowed' : 'pointer', padding: '4px 8px', lineHeight: 1, opacity: i === 0 ? 0.3 : 1, minWidth: 32, minHeight: 24 }}
                onClick={() => patch({ instructions: moveInstruction(draft.instructions, i, i - 1) })}
              >
                &#9650;
              </button>
              <button
                type="button"
                title="Move down"
                disabled={i === stepCount - 1}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: i === stepCount - 1 ? 'not-allowed' : 'pointer', padding: '4px 8px', lineHeight: 1, opacity: i === stepCount - 1 ? 0.3 : 1, minWidth: 32, minHeight: 24 }}
                onClick={() => patch({ instructions: moveInstruction(draft.instructions, i, i + 1) })}
              >
                &#9660;
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className={styles.deleteBtn}
            style={{ color: 'var(--red)', fontSize: 18, alignSelf: 'flex-start', marginTop: 6 }}
            title="Remove step"
            onClick={() => patch({ instructions: draft.instructions.filter((_, idx) => idx !== i) })}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.smallBtn}
        style={{ borderStyle: 'dashed', marginBottom: 14 }}
        onClick={() => patch({ instructions: [...draft.instructions, ''] })}
      >
        + Add step
      </button>

      <label style={labelStyle}>
        Tags (comma-separated)
        <input
          type="text"
          className={styles.textInput}
          placeholder="breakfast, vegetarian"
          value={draft.tagsRaw}
          onChange={(e) => patch({ tagsRaw: e.target.value })}
        />
      </label>
      <label style={labelStyle}>
        {showMyNotes ? 'Notes (from source)' : 'Notes'}
        <textarea
          className={styles.textarea}
          rows={2}
          style={{ fontSize: 13 }}
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </label>
      {showMyNotes ? (
        <label style={labelStyle}>
          My notes
          <textarea
            className={styles.textarea}
            rows={3}
            placeholder="What you tweaked, how it turned out…"
            value={draft.myNotes}
            onChange={(e) => patch({ myNotes: e.target.value })}
          />
        </label>
      ) : null}
      <div className={styles.muted12}>
        Source:{' '}
        {draft.base.source_url ? (
          <a href={draft.base.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ongoing)', textDecoration: 'none' }}>
            {draft.base.source_url}
          </a>
        ) : (
          draft.base.source_image || '—'
        )}
      </div>
    </>
  );
}
