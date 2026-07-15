/**
 * threadApproval.ts — pure editor-state helpers for kinds "thread_open" /
 * "thread_link" / "thread_retire" (threads-architecture.md §4, §8 step 4).
 *
 * All three kinds commit through the SERVER-side POST /api/pending/approve —
 * routes/pending.py::_commit shells to the `thread` CLI, the only writer of
 * thread files — so unlike todoApproval there's no native-endpoint payload
 * builder here. thread_open is the only kind with editable fields in v1;
 * thread_link and thread_retire are read-only review (the payload passes
 * through unchanged), so their helpers are display-only.
 */
import { asString } from './shared';
import type { JsonValue } from './types';

function arrayOfStrings(v: JsonValue | undefined): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** "a, b , ,c" -> ["a","b","c"] — trims each entry, drops empties. */
export function parseAliases(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Ordered multiselect toggle shared by fronts + parents: appends on add,
 * closes the gap on remove (plain filter — nothing is reordered). Position
 * carries the "first = primary" rule (threads-architecture.md §3), so
 * removing the current primary automatically promotes whichever is next.
 */
export function toggleOrdered(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export interface ThreadEvidenceItem {
  card: string;
  date: string;
  quote: string;
}

/** `evidence[]` — same `{card, date, quote}` shape across all three kinds.
 * Rendered ABOVE the controls, always (threads-architecture.md §4: "she
 * rules on the material, not the cricket's opinion of the material"). */
export function evidenceFromPayload(payload: Record<string, JsonValue>): ThreadEvidenceItem[] {
  const raw = payload.evidence;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, JsonValue> => !!e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => ({ card: asString(e.card), date: asString(e.date), quote: asString(e.quote) }));
}

export interface ThreadCardItem {
  section: string;
  text: string;
  source: string | string[];
}

/** thread_open's starter fact-cards — read-only in v1: they were validated
 * server-side at propose time, and editing them here risks re-failing that
 * validation on commit. */
export function cardsFromPayload(payload: Record<string, JsonValue>): ThreadCardItem[] {
  const raw = payload.cards;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, JsonValue> => !!c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      section: asString(c.section),
      text: asString(c.text),
      source: Array.isArray(c.source) ? arrayOfStrings(c.source) : asString(c.source),
    }));
}

// ── thread_open: the only editable kind ─────────────────────────────────────

export interface ThreadOpenDraft {
  name: string;
  /** Display only — identity, not edited (it's the check-slug/denial-memory
   * key, per threads-architecture.md §4). */
  slug: string;
  /** Raw comma-separated text as typed in the input — parsed by
   * parseAliases when building the submit payload. */
  aliasesText: string;
  kind: 'standing' | 'arc';
  /** Ordered; first = primary (owning cricket, §6). */
  fronts: string[];
  /** Ordered; first = primary (breadcrumb, §3). May be empty. */
  parents: string[];
}

/** Staged payload -> initial form state. */
export function threadOpenDraftFromPayload(payload: Record<string, JsonValue>): ThreadOpenDraft {
  return {
    name: asString(payload.name),
    slug: asString(payload.slug),
    aliasesText: arrayOfStrings(payload.aliases).join(', '),
    kind: asString(payload.kind) === 'arc' ? 'arc' : 'standing',
    fronts: arrayOfStrings(payload.fronts),
    parents: arrayOfStrings(payload.parents),
  };
}

/**
 * Draft -> the payload POSTed to /api/pending/approve. MERGES the edited
 * fields over the original staged payload so untouched fields — evidence,
 * cards, proposer, rationale — survive the round-trip and reach the ledger
 * + server intact.
 */
export function threadOpenPayloadFromDraft(
  draft: ThreadOpenDraft,
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    ...payload,
    name: draft.name.trim(),
    slug: draft.slug,
    aliases: parseAliases(draft.aliasesText),
    kind: draft.kind,
    fronts: draft.fronts,
    parents: draft.parents,
  };
}

// ── thread_link: read-only review, no editing in v1 ─────────────────────────

export interface LinkChangeRow {
  op: 'add' | 'remove';
  what: 'front' | 'parent';
  id: string;
}

/** Flattens the four add/remove arrays into display rows, stable order:
 * front changes before parent changes, adds before removes within each. */
export function linkChangeRows(payload: Record<string, JsonValue>): LinkChangeRow[] {
  const rows: LinkChangeRow[] = [];
  for (const id of arrayOfStrings(payload.add_fronts)) rows.push({ op: 'add', what: 'front', id });
  for (const id of arrayOfStrings(payload.remove_fronts)) rows.push({ op: 'remove', what: 'front', id });
  for (const id of arrayOfStrings(payload.add_parents)) rows.push({ op: 'add', what: 'parent', id });
  for (const id of arrayOfStrings(payload.remove_parents)) rows.push({ op: 'remove', what: 'parent', id });
  return rows;
}

/** "+ front: job" / "− parent: x" — the chip label for one row. */
export function linkRowLabel(row: LinkChangeRow): string {
  return `${row.op === 'add' ? '+' : '−'} ${row.what}: ${row.id}`;
}

// ── display helpers shared by thread_link / thread_retire ───────────────────

/** Resolves a slug to its thread name via the roster (useThreads), falling
 * back to the bare slug when the thread isn't in the roster (e.g. not yet
 * loaded, or — thread_retire on something already gone). */
export function threadNameForSlug(threads: { id: string; name: string }[], slug: string): string {
  return threads.find((t) => t.id === slug)?.name || slug;
}

/** "last card: 2026-06-10" — thread_retire's date line. '' when absent so
 * callers can skip rendering it entirely. */
export function lastCardLabel(lastCardDate: string): string {
  return lastCardDate ? `last card: ${lastCardDate}` : '';
}
