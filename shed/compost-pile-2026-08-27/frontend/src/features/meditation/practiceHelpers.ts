/**
 * practiceHelpers.ts — pure logic for the Practice stream, ported from
 * static/js/meditation.js (medTypeLabel / medSlug / medFormatDate / the
 * stream's sort + custom-tag collection). No DOM, no fetch — vitest-friendly.
 */

import type { MeditationEntry } from './types';

export const MED_TYPE_LABELS: Record<string, string> = {
  sitting: 'Sitting',
  walking: 'Walking',
  deity_yoga: 'Deity yoga',
  metta: 'Metta',
  vipassana: 'Vipassana',
};

export const MED_TYPE_ORDER = ['sitting', 'walking', 'deity_yoga', 'metta', 'vipassana'] as const;

/** Slug -> display label; unknown slugs get Title Cased with underscores as spaces. */
export function medTypeLabel(t: string | null | undefined): string {
  if (t && MED_TYPE_LABELS[t]) return MED_TYPE_LABELS[t];
  if (!t) return '—';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Free-typed custom tag name -> stored slug ("Tonglen!" -> "tonglen"). */
export function medSlug(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** "Wed, Jul 9, 2026" — noon anchoring avoids UTC date shifts. */
export function formatEntryDate(iso: string | null | undefined): string {
  if (!iso) return 'undated';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Stream order: date desc, then id desc as a stable tiebreaker. */
export function sortEntries(entries: MeditationEntry[]): MeditationEntry[] {
  return entries.slice().sort((a, b) => {
    const av = a.date || '0000-00-00';
    const bv = b.date || '0000-00-00';
    if (av !== bv) return bv.localeCompare(av);
    return (b.id || '').localeCompare(a.id || '');
  });
}

/**
 * Non-builtin tags seen on existing entries, merged with any custom tags
 * added in this compose session, sorted — these render as extra chips.
 */
export function collectCustomTypes(entries: MeditationEntry[], extra: string[]): string[] {
  const custom = new Set<string>();
  entries.forEach((e) => (e.types || []).forEach((t) => {
    if (!MED_TYPE_LABELS[t]) custom.add(t);
  }));
  extra.forEach((t) => custom.add(t));
  return Array.from(custom).sort();
}

/** Label for the delete-confirm modal: "Sitting + Metta", falling back to "cell". */
export function entryTagSummary(entry: MeditationEntry): string {
  return (entry.types || []).map(medTypeLabel).join(' + ') || 'cell';
}
