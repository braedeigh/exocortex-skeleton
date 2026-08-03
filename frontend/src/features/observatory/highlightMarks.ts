/**
 * highlightMarks.ts — turning a text selection in the conversation into
 * character offsets, and turning those offsets back into visible marks.
 *
 * WHY THIS IS DOM WORK AND NOT STRING WORK. A keeper reply is markdown rendered
 * to HTML (replyViews.tsx does `dangerouslySetInnerHTML`), so what she actually
 * selects with her finger are text nodes scattered through paragraphs, list
 * items and bold spans — there's no string to slice. So the offsets stored for
 * a highlight count characters across the RENDERED text (everything
 * `textContent` would give you), and re-lighting a saved highlight means
 * walking those text nodes again and wrapping the stretch that falls inside the
 * range. Her own messages are plain text, which is just the easy case of the
 * same walk.
 *
 * The one piece with real logic — deciding where a saved highlight actually
 * sits now — is `resolveHighlight`, kept pure and string-only so it can be
 * tested without a browser (highlightMarks.test.ts).
 *
 * Used by ObservatoryPage.tsx (the selection listener behind the ✦ pill) and
 * replyViews.tsx (painting saved marks after each render). The offsets travel
 * to the server through api.ts `journalHighlight` and come back on reload as
 * `journal-highlight` events (events.ts).
 *
 * Prompt: "if I highlight something a little tap comes up for me to put that in
 * my journal whether it be keeper output or my output."
 */

export interface Anchor {
  start: number;
  end: number;
  quote: string;
}

/** Longest quote we'll try to re-find by searching. Past this, an exact-offset
 * miss means the text really changed and searching just burns time. */
const MAX_SEARCH_QUOTE = 2000;

/**
 * Where a saved highlight sits in `text` now, or null if it's gone.
 *
 * Three outcomes, in the order they're tried:
 *  - the offsets still land exactly on the quote → use them (the normal case);
 *  - they don't, but the quote appears somewhere → use that (the text reflowed,
 *    e.g. a reply that finished streaming after the mark was made);
 *  - the quote isn't there at all → null, and nothing is lit. A mark on the
 *    wrong words is worse than no mark.
 *
 * A highlight saved without a quote (shouldn't happen, but a hand-edited log
 * could) falls back to trusting its offsets as long as they're in bounds.
 */
export function resolveHighlight(text: string, h: Anchor): { start: number; end: number } | null {
  const { start, end, quote } = h;
  if (!quote) {
    if (start >= 0 && end > start && end <= text.length) return { start, end };
    return null;
  }
  if (text.slice(start, end) === quote) return { start, end };
  if (quote.length > MAX_SEARCH_QUOTE) return null;
  const found = text.indexOf(quote);
  if (found === -1) return null;
  return { start: found, end: found + quote.length };
}

/** Drop marks that no longer resolve, sort what's left, and merge any that
 * touch or overlap. Both matter to the painter: it walks the container forward
 * once, and two marks over the same characters would try to wrap the same text
 * node twice — overlapping highlights read as one lit stretch anyway, so
 * merging is also what she'd expect to see. */
export function resolveAll(text: string, marks: Anchor[]): { start: number; end: number }[] {
  const resolved = marks
    .map((m) => resolveHighlight(text, m))
    .filter((r): r is { start: number; end: number } => r !== null)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of resolved) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Character offsets of the current selection within `container`, or null if
 * the selection is empty or lives somewhere else. Same clone-and-measure trick
 * the research Annotator uses: a range collapsed to the selection's start,
 * expanded back to the container, is exactly as long as the text before it. */
export function selectionOffsets(container: HTMLElement): Anchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + quote.length, quote };
}

/** Where to float the pill: centred over the selection, above it, clamped into
 * the viewport so it can't land off-screen on a selection at the very top or
 * hard against an edge. Returns viewport coordinates (the pill is fixed). */
export function selectionAnchorPoint(width: number, height: number): { left: number; top: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const gap = 10;
  return {
    left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)),
    // Above the selection by default; below it when there's no room up there.
    top: rect.top - height - gap < 8 ? rect.bottom + gap : rect.top - height - gap,
  };
}

const MARK_CLASS_ATTR = 'data-journal-mark';

/** Remove marks this module painted, unwrapping them back into plain text. Runs
 * before every repaint so marks never stack up across renders. `normalize()`
 * re-joins the text nodes the unwrap left split, which matters: the offsets are
 * counted across text nodes, and a container that fragments a little more on
 * each pass would still measure the same but paint slower and slower. */
export function clearMarks(container: HTMLElement): void {
  const existing = container.querySelectorAll(`[${MARK_CLASS_ATTR}]`);
  for (const el of Array.from(existing)) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }
  if (existing.length) container.normalize();
}

/**
 * Paint `marks` (already resolved to offsets in the container's rendered text)
 * as <mark> elements. Walks the text nodes once, tracking how many characters
 * have gone by, and splits any node that straddles a boundary — so a highlight
 * running across a bold word or a line break comes out as several marks that
 * read as one continuous stretch, which is what the CSS is drawn for.
 *
 * Collecting the splits first and applying them after the walk keeps the
 * TreeWalker from tripping over nodes it's already handed back.
 */
export function paintMarks(container: HTMLElement, marks: { start: number; end: number }[], className: string): void {
  clearMarks(container);
  if (!marks.length) return;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const pieces: { node: Text; from: number; to: number }[] = [];
  let seen = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    const nodeStart = seen;
    const nodeEnd = seen + len;
    for (const m of marks) {
      const from = Math.max(m.start, nodeStart);
      const to = Math.min(m.end, nodeEnd);
      if (to > from) pieces.push({ node, from: from - nodeStart, to: to - nodeStart });
    }
    seen = nodeEnd;
    node = walker.nextNode() as Text | null;
  }

  // Back to front within each node, so an earlier split can't shift the
  // offsets of a later one in the same node.
  for (const piece of pieces.reverse()) {
    const { node: text, from, to } = piece;
    const tail = text.splitText(from);
    tail.splitText(to - from);
    const mark = document.createElement('mark');
    mark.setAttribute(MARK_CLASS_ATTR, '');
    mark.className = className;
    tail.parentNode?.insertBefore(mark, tail);
    mark.appendChild(tail);
  }
}
