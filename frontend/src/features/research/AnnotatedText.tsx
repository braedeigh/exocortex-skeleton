/**
 * AnnotatedText.tsx — a document's text with its highlights laid over it.
 * Purely presentational: give it the raw text and the doc's annotations and
 * it draws the non-overlapping marks (amber until reviewed, green after,
 * outlined when active), scrolls the active one into view, and — when asked
 * to — turns a text selection back into character offsets. It knows nothing
 * about saving, research sessions, or which page it sits on.
 *
 * Used by Annotator.tsx (the editing overlay, which adds the "Annotate" pop
 * and the side list) and ClaimsPage.tsx (read-only source pane beside a
 * claim). The mark math is anchor.ts's markSegments; layoutMarks() below is
 * the pure step between that and the JSX, kept separate so it can be tested
 * without a DOM.
 *
 * Extracted from Annotator.tsx on the prompt: "Extract the highlighted-text
 * renderer out of Annotator.tsx (plus the scroll-to-mark effect and the
 * selection→offsets handler) into a presentational AnnotatedText.tsx with
 * props { text, annotations, activeId, onMarkClick(id), onSelectRange? }."
 */

import { useEffect, useRef, type Ref } from 'react';
import { annotationMarkInputs, markSegments } from './anchor';
import type { Annotation } from './types';
import styles from './AnnotatedText.module.css';

/** What one rendered piece of the document is: plain text, or a mark with
 * the flags the renderer needs to pick its class. */
export interface MarkLayoutSegment {
  text: string;
  mark?: { id: string; needsReview: boolean; active: boolean };
}

/** Lay the marks over the text, flagging the active one.
 * Runs markSegments (greedy, non-overlapping) and stamps `active` on the
 * segment whose annotation id matches — the last pure step before JSX. */
export function layoutMarks(text: string, annotations: Annotation[], activeId: string | null): MarkLayoutSegment[] {
  return markSegments(text, annotationMarkInputs(annotations)).map((segment) =>
    segment.mark
      ? { text: segment.text, mark: { ...segment.mark, active: segment.mark.id === activeId } }
      : { text: segment.text },
  );
}

/** Scroll one highlight to the middle of its scroll container.
 * Waits a paint so the active outline is applied before the scroll starts. */
export function scrollToMark(container: HTMLElement | null, id: string): void {
  if (!container) return;
  requestAnimationFrame(() => {
    const mark = container.querySelector(`mark[data-ann="${CSS.escape(id)}"]`);
    if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

export interface AnnotatedTextProps {
  text: string;
  annotations: Annotation[];
  activeId: string | null;
  onMarkClick: (id: string) => void;
  /** Fires when the reader selects a run of text inside the document, with
   * the selection's character offsets and its screen rectangle (so a caller
   * can float a button beside it). Omit it for a read-only view. */
  onSelectRange?: (start: number, end: number, exact: string, rect: DOMRect) => void;
  /** Fires when a selection ends empty or outside the document. */
  onSelectionClear?: () => void;
  /** True while the text is still on its way — shows "Loading…". */
  loading?: boolean;
  /** Extra class for the scroll container (layout belongs to the caller). */
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function AnnotatedText({
  text,
  annotations,
  activeId,
  onMarkClick,
  onSelectRange,
  onSelectionClear,
  loading = false,
  className = '',
  ref,
}: AnnotatedTextProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Hand the container to both our own ref and the caller's.
  function setContainer(node: HTMLDivElement | null) {
    containerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }

  const segments = layoutMarks(text, annotations, activeId);
  const hasActiveMark = segments.some((segment) => segment.mark?.active);

  // Bring the active highlight into view.
  // Re-runs when the active id changes or when its mark first appears (text
  // and annotations arrive from two separate fetches) — not on every poll.
  useEffect(() => {
    if (activeId && hasActiveMark) scrollToMark(containerRef.current, activeId);
  }, [activeId, hasActiveMark]);

  // Turn a text selection into character offsets.
  // Marks contribute their inner text only, so the rendered textContent maps
  // 1:1 onto the raw document string; the selection's start offset is the
  // length of everything before it. Listens at the document level (the
  // selection ends wherever the pointer lifts) and waits 10ms so the browser
  // has settled the selection first.
  const selectRangeRef = useRef(onSelectRange);
  const selectionClearRef = useRef(onSelectionClear);
  selectRangeRef.current = onSelectRange;
  selectionClearRef.current = onSelectionClear;
  const selectable = !!onSelectRange;
  useEffect(() => {
    if (!selectable) return;
    function onSelectionEnd() {
      setTimeout(() => {
        const container = containerRef.current;
        const selection = window.getSelection();
        if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
          selectionClearRef.current?.();
          return;
        }
        const range = selection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          selectionClearRef.current?.();
          return;
        }
        const before = range.cloneRange();
        before.selectNodeContents(container);
        before.setEnd(range.startContainer, range.startOffset);
        const start = before.toString().length;
        const length = range.toString().length;
        if (!length) {
          selectionClearRef.current?.();
          return;
        }
        selectRangeRef.current?.(start, start + length, range.toString(), range.getBoundingClientRect());
      }, 10);
    }
    document.addEventListener('mouseup', onSelectionEnd);
    document.addEventListener('touchend', onSelectionEnd);
    return () => {
      document.removeEventListener('mouseup', onSelectionEnd);
      document.removeEventListener('touchend', onSelectionEnd);
    };
  }, [selectable]);

  return (
    <div className={`${styles.text} ${className}`} ref={setContainer}>
      {loading ? (
        <span className={styles.empty}>Loading&hellip;</span>
      ) : segments.length ? (
        segments.map((segment, index) =>
          segment.mark ? (
            <mark
              key={index}
              data-ann={segment.mark.id}
              className={`${styles.mark} ${segment.mark.needsReview ? '' : styles.markReviewed} ${
                segment.mark.active ? styles.markActive : ''
              }`}
              onClick={() => onMarkClick(segment.mark!.id)}
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )
      ) : (
        <span className={styles.empty}>Empty document.</span>
      )}
    </div>
  );
}
