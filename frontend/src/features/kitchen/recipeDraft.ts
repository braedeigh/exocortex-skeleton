/**
 * recipeDraft.ts — editable form model shared by the parsed-recipe review
 * modal and the in-page recipe editor. Mirrors _readRecipeFromModal /
 * _readRecipeFromEditForm: numbers pass through as strings until save, empty
 * ingredient/step rows are dropped at save time, and the variant-chain /
 * choice-group / sections fields are carried forward verbatim.
 */
import type { Recipe, RecipeIngredient } from './types';

export interface RecipeDraft {
  base: Recipe;
  name: string;
  servings: string;
  prep: string;
  cook: string;
  ingredients: RecipeIngredient[];
  instructions: string[];
  tagsRaw: string;
  notes: string;
  myNotes: string;
}

export function draftFromRecipe(r: Recipe): RecipeDraft {
  return {
    base: r,
    name: r.name || '',
    servings: r.servings == null ? '' : String(r.servings),
    prep: r.prep_min == null ? '' : String(r.prep_min),
    cook: r.cook_min == null ? '' : String(r.cook_min),
    ingredients: (r.ingredients || []).map((i) => ({ ...i })),
    instructions: (r.instructions || []).slice(),
    tagsRaw: (r.tags || []).join(', '),
    notes: r.notes || '',
    myNotes: r.my_notes || '',
  };
}

export function recipeFromDraft(d: RecipeDraft): Recipe {
  const base = d.base;
  return {
    id: base.id,
    name: d.name.trim(),
    source_url: base.source_url || null,
    source_image: base.source_image || null,
    servings: d.servings ? Number(d.servings) : null,
    prep_min: d.prep ? Number(d.prep) : null,
    cook_min: d.cook ? Number(d.cook) : null,
    ingredients: d.ingredients
      .map((i) => ({
        item: (i.item || '').trim(),
        qty: (i.qty || '').trim(),
        category: i.category || 'other',
        stocking_status: i.stocking_status || '',
        note: (i.note || '').trim(),
      }))
      .filter((i) => i.item),
    instructions: d.instructions.map((s) => s.trim()).filter(Boolean),
    tags: d.tagsRaw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    notes: d.notes.trim(),
    my_notes: d.myNotes.trim(),
    created: base.created,
    // Carry the variant-chain fields so an in-place Save doesn't clobber them.
    parent_id: base.parent_id == null ? null : base.parent_id,
    is_archived: base.is_archived === true,
    // Carry choice groups + last picks (not editable from the form).
    choice_groups: base.choice_groups || [],
    last_picks: base.last_picks || {},
    // Carry step sections forward verbatim — the flat editor doesn't restructure them.
    ...(Array.isArray(base.sections) && base.sections.length ? { sections: base.sections } : {}),
  };
}

export function moveInstruction(instructions: string[], from: number, to: number): string[] {
  if (to < 0 || to >= instructions.length || from === to) return instructions;
  const next = instructions.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
