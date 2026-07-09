/** Pure logic for the Triage + Food sensitivities cards — port of kitchen.js
 * renderFoodTriage / renderSafeFoods / renderSuspectFoods / renderInflammatoryFoods. */
import type { SafetyTag } from './types';

export interface TriageItem {
  name: string;
  count: number;
  lastBought: string | null;
}

/**
 * Untagged catalog items, most-bought first then alphabetical. Purchase
 * counts/last-bought aren't in the body payload today, so they default to
 * 0/null (the old page degraded the same way) — the sort then falls through
 * to alphabetical.
 */
export function untaggedFoods(
  known: Record<string, string> | undefined,
  tags: Record<string, SafetyTag> | undefined,
  counts: Record<string, number> | undefined,
  lastBought: Record<string, string> | undefined,
): TriageItem[] {
  const t = tags || {};
  return Object.keys(known || {})
    .filter((name) => !t[name])
    .map((name) => ({
      name,
      count: (counts || {})[name] || 0,
      lastBought: (lastBought || {})[name] || null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** All foods carrying `tag`, alphabetical — one chip cloud's contents. */
export function taggedFoods(tags: Record<string, SafetyTag> | undefined, tag: SafetyTag): string[] {
  return Object.entries(tags || {})
    .filter(([, t]) => t === tag)
    .map(([name]) => name)
    .sort();
}

/** "today" / "yesterday" / "5d ago" / "3w ago" — triage-row recency label. */
export function agoLabel(lastBought: string, today: string): string {
  const lb = Date.parse(lastBought + 'T12:00:00Z');
  const now = Date.parse(today + 'T12:00:00Z');
  if (Number.isNaN(lb) || Number.isNaN(now)) return '';
  const days = Math.round((now - lb) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

/** "bought 3× · 2d ago" (either part optional) — triage-row meta text. */
export function triageMeta(item: TriageItem, today: string): string {
  const parts: string[] = [];
  if (item.count) parts.push(`bought ${item.count}×`);
  if (item.lastBought) {
    const label = agoLabel(item.lastBought, today);
    if (label) parts.push(label);
  }
  return parts.join(' · ');
}

/** "chicken" -> "Chicken" — chip/row display casing. */
export function displayName(name: string): string {
  return (name || '').charAt(0).toUpperCase() + (name || '').slice(1);
}
