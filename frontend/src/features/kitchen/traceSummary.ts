/**
 * traceSummary.ts — a recipe's sourcing in one line: "3 of 9 traced".
 *
 * What this file does: takes the breakdown ecoRecipeSourcing
 * (features/ecosystem/ecoMatch.ts) makes of a recipe — traced, untraced,
 * pantry — and counts what's traced out of what could be. Pantry staples
 * (salt, oil, spices) stay out of both numbers: there's nothing meaningful to
 * trace, so they'd only make the recipe look less known than it is. The
 * recipe card (RecipeDetailView.tsx) shows the line under "Where it comes from".
 *
 * Prompt that produced it: "A recipe shows where its ingredients come from, in
 * one line ... and links into the hub."
 */
import type { RecipeSourcing } from '../ecosystem/ecoMatch';

export interface TraceSummary {
  traced: number;
  traceable: number;
  text: string;
}

export function traceSummary(sourcing: RecipeSourcing): TraceSummary {
  const traced = sourcing.traced.length;
  const traceable = traced + sourcing.place.length;
  return { traced, traceable, text: `${traced} of ${traceable} traced` };
}
