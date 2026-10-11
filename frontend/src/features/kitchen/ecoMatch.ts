/**
 * ecoMatch.ts — the kitchen's colour key for a source's transparency.
 *
 * Tracing a recipe to the map used to be matched here by shared words; it now
 * follows real links (food_links in SQL) and lives in one place,
 * features/ecosystem/ecoMatch.ts, which the recipe card imports. What's left
 * is the dot colour the card paints beside each traced ingredient.
 */
import type { EcoSource } from './types';

/** Transparency → dot color/label, mirroring ecosystem.js's ECO_TX. */
export const ECO_TX: Record<string, { color: string; label: string }> = {
  disclosed: { color: '#2f9e7f', label: 'disclosed' },
  partial: { color: '#e0a82e', label: 'partial' },
  opaque: { color: '#d4554a', label: 'opaque' },
  unrated: { color: '#9aa0a6', label: 'unrated' },
};

export function ecoTx(source: EcoSource | null | undefined): { color: string; label: string } {
  return (source && source.transparency && ECO_TX[source.transparency]) || ECO_TX.unrated;
}
