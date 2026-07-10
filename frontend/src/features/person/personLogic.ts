/**
 * personLogic.ts — pure helpers for the person page, ported from
 * static/js/person.js (renderFacts' key ordering + buildCurrentFacts,
 * renderStory's Referenced-In strip, renderReceipts' nav classification,
 * monthYear). No DOM, no fetch — everything here is unit-tested.
 */

import type { PersonMention } from './types';

/** The four facts that always show, in this order (person.js SEED_FACTS). */
export const SEED_FACTS = ['relationship', 'age', 'lives', 'work'] as const;

/** Frontmatter keys the facts editor must never touch (person.js RESERVED_KEYS). */
export const RESERVED_FACT_KEYS: ReadonlySet<string> = new Set(['tags', 'aliases']);

/** "relationship" -> "Relationship" — the label treatment the old page used. */
export function capitalizeKey(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** "Mon YYYY" — e.g. "Feb 2026". */
export function monthYear(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Display rows for the Facts section: the seed fields always (empty ->
 * "add…" placeholder), then every other stored fact in file order.
 */
export function factRows(facts: Record<string, string>): Array<{ key: string; value: string }> {
  const keys: string[] = [...SEED_FACTS];
  for (const k of Object.keys(facts)) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((key) => ({ key, value: facts[key] || '' }));
}

/**
 * The full facts map to POST after an edit — port of person.js
 * buildCurrentFacts() + the edited key applied on top: every currently
 * displayed non-empty fact keeps its value, seed keys not present are sent
 * as '' (the server treats '' as delete / leave absent), and `edits` wins.
 */
export function buildFactsPayload(
  facts: Record<string, string>,
  edits: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const { key, value } of factRows(facts)) {
    if (value) payload[key] = value;
  }
  for (const k of SEED_FACTS) {
    if (!(k in payload)) payload[k] = '';
  }
  for (const [k, v] of Object.entries(edits)) {
    payload[k] = v;
  }
  return payload;
}

/**
 * Story = the file's narrative body minus the "## Referenced In" tail —
 * that tail is the same data Receipts renders, structured. (person.js
 * renderStory.)
 */
export function storyText(body: string | null | undefined): string {
  let text = body || '';
  const idx = text.search(/^##\s+Referenced In/im);
  if (idx !== -1) text = text.slice(0, idx);
  return text.trim();
}

/** Where a receipt row goes: a journal day in-app, or a keeper file. */
export type ReceiptNav = { kind: 'journal'; date: string } | { kind: 'keeper'; path: string };

/** person.js renderReceipts: daily-journal mentions deep-link to the journal, everything else opens the keeper file. */
export function mentionNav(m: Pick<PersonMention, 'file' | 'date'>): ReceiptNav {
  if (m.file.startsWith('Journal/Daily/') && m.date) {
    return { kind: 'journal', date: m.date };
  }
  return { kind: 'keeper', path: m.file };
}
