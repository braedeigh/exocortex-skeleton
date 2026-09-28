/**
 * newCategory.ts — "make a new budget category right here" for the Money page.
 * Asks for a name, saves it to the budget unless one by that name already
 * exists, and hands back the name to select. Log expense's + button
 * (QuickExpense.tsx) and the Spending-by-month drill-down's category dropdown
 * (SpendingBreakdownSection.tsx) both use it. The statement preview keeps its
 * own + because its new names only save when the import runs.
 */
import type { AddCategoryPayload } from './api';

/** The dropdown value that means "make a new category" rather than a real one. */
export const NEW_CATEGORY_OPTION = '__new_category__';

/**
 * Ask for a new category name and save it to the budget.
 * Returns the name to select (an existing one if she typed a name that's
 * already there, in any capitalisation), or null if she cancelled or the save
 * failed (the failure is already toasted by the caller's mutation).
 */
export async function promptNewCategory(
  existing: string[],
  onAddCategory: (payload: AddCategoryPayload) => Promise<unknown>,
): Promise<string | null> {
  const name = (window.prompt('New category name:', '') || '').trim();
  if (!name) return null;
  const match = existing.find((c) => c.toLowerCase() === name.toLowerCase());
  if (match) return match;
  try {
    await onAddCategory({ name, planned: 0, type: 'variable' });
  } catch {
    return null;
  }
  return name;
}
