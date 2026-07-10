/**
 * anchor.ts — pure character-anchor math for the annotator.
 *
 * Two halves, both zero-DOM and total (malformed input degrades, never
 * throws):
 *
 * 1. A TypeScript twin of the server's textanchor.py (make/verify/relocate/
 *    resolve). The server is the source of truth — GET /api/annotations
 *    resolves every selector against the live doc text (verified/relocated/
 *    lost) — but the client re-runs the same math defensively so marks stay
 *    honest between refetches (e.g. right after an optimistic add). Keep in
 *    sync with textanchor.py.
 *
 * 2. markSegments() — the greedy non-overlapping highlight pass ported from
 *    the old research.js _annMarksHtml(): resolved selectors are sorted by
 *    (start, end) and laid over the text left-to-right; an annotation that
 *    overlaps an earlier mark loses its mark (but stays in the side list).
 */

import type { Annotation, AnnotationState, Selector } from './types';

/** Build a selector for text[charStart:charEnd], or null if invalid
 * (out-of-bounds, start >= end, empty slice, non-numeric input). */
export function makeSelector(text: string, charStart: number, charEnd: number): Selector | null {
  if (typeof charStart !== 'number' || typeof charEnd !== 'number') return null;
  if (!Number.isFinite(charStart) || !Number.isFinite(charEnd)) return null;
  const start = Math.trunc(charStart);
  const end = Math.trunc(charEnd);
  if (start < 0 || end < 0 || start >= end || end > text.length) return null;
  const exact = text.slice(start, end);
  if (!exact) return null;
  return { exact, char_start: start, char_end: end };
}

/** Pull (exact, start, end) out of a selector, or null on a malformed shape. */
function fields(sel: unknown): [string, number, number] | null {
  if (typeof sel !== 'object' || sel === null) return null;
  const s = sel as Record<string, unknown>;
  const exact = s.exact;
  const start = s.char_start;
  const end = s.char_end;
  if (typeof exact !== 'string' || !exact) return null;
  if (typeof start !== 'number' || !Number.isInteger(start)) return null;
  if (typeof end !== 'number' || !Number.isInteger(end)) return null;
  return [exact, start, end];
}

/** True iff text[char_start:char_end] === exact. */
export function verifySelector(text: string, sel: unknown): boolean {
  const f = fields(sel);
  if (f === null) return false;
  const [exact, start, end] = f;
  if (start < 0 || end > text.length || start >= end) return false;
  return text.slice(start, end) === exact;
}

/**
 * When verify fails, look for `exact` elsewhere in `text` and return a new
 * selector at the occurrence whose char_start is nearest the original one
 * (exact distance ties broken by favoring the earlier occurrence). Null when
 * `exact` no longer occurs anywhere — the annotation is "lost".
 */
export function relocateSelector(text: string, sel: unknown): Selector | null {
  const f = fields(sel);
  if (f === null) return null;
  const [exact, start] = f;
  const occurrences: number[] = [];
  let idx = text.indexOf(exact);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = text.indexOf(exact, idx + 1);
  }
  if (!occurrences.length) return null;
  let best = occurrences[0];
  for (const o of occurrences) {
    if (Math.abs(o - start) < Math.abs(best - start) || (Math.abs(o - start) === Math.abs(best - start) && o < best)) {
      best = o;
    }
  }
  return { exact, char_start: best, char_end: best + exact.length };
}

export interface ResolvedSelector {
  state: 'verified' | 'relocated' | 'lost';
  selector: Selector | null;
}

/** Resolve a selector against the current text: verified / relocated / lost.
 * Returns the original selector when verified or lost, the relocated one
 * when relocated. Never throws, even on malformed input. */
export function resolveSelector(text: string, sel: unknown): ResolvedSelector {
  if (verifySelector(text, sel)) {
    return { state: 'verified', selector: sel as Selector };
  }
  const relocated = relocateSelector(text, sel);
  if (relocated !== null) return { state: 'relocated', selector: relocated };
  return { state: 'lost', selector: fields(sel) === null ? null : (sel as Selector) };
}

// --- Highlight segmentation (the old _annMarksHtml, minus the HTML) ---

export interface MarkInput {
  id: string;
  selector?: Selector | null;
  state?: AnnotationState;
  needsReview: boolean;
}

export interface TextSegment {
  text: string;
  /** absent = plain text between marks */
  mark?: { id: string; needsReview: boolean };
}

/**
 * Split `text` into plain/marked segments from resolved selectors, greedy and
 * non-overlapping: spans sort by (start, end); a span starting before the
 * previous mark ended is dropped (its annotation keeps its list row, it just
 * loses its highlight). Invalid spans (lost/unresolved state, missing
 * selector, non-integer or out-of-range offsets, empty range) are filtered.
 */
export function markSegments(text: string, items: MarkInput[]): TextSegment[] {
  const spans = items
    .filter((a) => a.state !== 'lost' && a.state !== 'unresolved' && a.selector)
    .map((a) => ({
      id: a.id,
      s: a.selector!.char_start,
      e: a.selector!.char_end,
      needsReview: a.needsReview,
    }))
    .filter(
      (x) => Number.isInteger(x.s) && Number.isInteger(x.e) && x.s >= 0 && x.e <= text.length && x.s < x.e,
    )
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const out: TextSegment[] = [];
  let pos = 0;
  for (const sp of spans) {
    if (sp.s < pos) continue; // overlaps an earlier mark — loses its mark
    if (sp.s > pos) out.push({ text: text.slice(pos, sp.s) });
    out.push({ text: text.slice(sp.s, sp.e), mark: { id: sp.id, needsReview: sp.needsReview } });
    pos = sp.e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

/** Adapter: server annotations -> markSegments input. */
export function annotationMarkInputs(annotations: Annotation[]): MarkInput[] {
  return annotations.map((a) => ({
    id: a.id,
    selector: a.selector ?? null,
    state: a.state,
    needsReview: !!a.needs_review,
  }));
}
