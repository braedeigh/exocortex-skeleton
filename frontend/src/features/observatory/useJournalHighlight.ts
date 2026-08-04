/**
 * useJournalHighlight.ts — the highlight-a-span-into-the-journal subsystem,
 * whole: the document-level selection listener, the pending-highlight state
 * the ✦ pill floats on, the sheet's open/saving/error lifecycle, and the save
 * that mints the card and paints the mark. JournalHighlight.tsx stays the
 * dumb view (pill + sheet); this hook is everything behind it. Lived inline
 * in ObservatoryPage (~130 lines of its state machine) until 08-03.
 *
 * One listener for the whole transcript rather than a handler per turn: what
 * she selects is a range, and a range doesn't belong to a component. The
 * `[data-turn]` element it lands inside says which turn it was and in whose
 * voice, and it's also the element the offsets are counted against — so the
 * same lookup answers both questions.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { journalHighlight } from './api';
import { PILL_HEIGHT, PILL_WIDTH } from './JournalHighlight';
import { selectionAnchorPoint, selectionOffsets } from './highlightMarks';
import type { Turn } from './events';

/** A live text selection inside the transcript, ready to become a journal
 * card: which turn it landed in, whose voice said it, the character range
 * within that turn's rendered text, the selected text itself, and viewport
 * coordinates for the ✦ pill. */
export interface PendingHighlight {
  turn: number;
  who: 'B' | 'K';
  start: number;
  end: number;
  quote: string;
  left: number;
  top: number;
}

export function useJournalHighlight(args: {
  /** The conversation this page is writing into — a ref because the save runs
   * from a stable callback. */
  convRef: RefObject<string | undefined>;
  turnsRef: RefObject<Turn[]>;
  onTurns: (turns: Turn[]) => void;
}) {
  const { convRef, turnsRef, onTurns } = args;
  const [pending, setPending] = useState<PendingHighlight | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The save runs from a stable callback, so it reads the selection through a
  // ref — same arrangement as the page's turnsRef/convRef.
  const pendingRef = useRef<PendingHighlight | null>(null);
  pendingRef.current = pending;
  // The selection listener has to know the sheet is up: once it is, the
  // selection has done its job and every later click (into the note box, onto
  // Keep) collapses it — without this guard that collapse would read as "she
  // deselected" and close the sheet out from under her.
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  useEffect(() => {
    function onSelectionEnd() {
      // A beat, so the browser has finished settling the selection (and, on
      // touch, finished its own long-press adjustment) before it's measured.
      window.setTimeout(() => {
        if (sheetOpenRef.current) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setPending(null);
          return;
        }
        const node = sel.getRangeAt(0).commonAncestorContainer;
        const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('[data-turn]');
        const host = el as HTMLElement | null;
        const who = host?.dataset.who;
        if (!host || (who !== 'B' && who !== 'K')) {
          setPending(null);
          return;
        }
        const anchor = selectionOffsets(host);
        const at = selectionAnchorPoint(PILL_WIDTH, PILL_HEIGHT);
        if (!anchor || !at) {
          setPending(null);
          return;
        }
        setPending({ turn: Number(host.dataset.turn), who, ...anchor, ...at });
      }, 10);
    }
    // The pill is positioned in viewport coordinates, so it has to be re-aimed
    // when the text moves under it — otherwise reading a little further down
    // before deciding to keep something leaves the pill stranded mid-air.
    function onScroll() {
      if (!pendingRef.current || sheetOpenRef.current) return;
      const at = selectionAnchorPoint(PILL_WIDTH, PILL_HEIGHT);
      if (at) setPending((p) => (p ? { ...p, ...at } : p));
    }
    document.addEventListener('mouseup', onSelectionEnd);
    document.addEventListener('touchend', onSelectionEnd);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onSelectionEnd);
      document.removeEventListener('touchend', onSelectionEnd);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  /** The ✦ pill's tap. Sets the ref by hand as well as the state: the mouseup
   * that follows this mousedown runs its check on a 10ms timer, which can
   * beat React's re-render, and the check reads the ref. */
  const openSheet = useCallback(() => {
    setError(null);
    sheetOpenRef.current = true;
    setSheetOpen(true);
  }, []);

  const cancel = useCallback(() => {
    setSheetOpen(false);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const save = useCallback(
    async (note: string) => {
      const conv = convRef.current;
      const p = pendingRef.current;
      if (!conv || !p) return;
      setSaving(true);
      setError(null);
      try {
        const res = await journalHighlight(conv, {
          who: p.who,
          quote: p.quote,
          note,
          turn: p.turn,
          start: p.start,
          end: p.end,
        });
        const t = turnsRef.current[p.turn];
        if (t) {
          // A NEW array, not a push: Reply is memoized on its props, and a
          // mutated-in-place array is the same reference, so the mark would
          // never get painted until something else forced a render.
          t.highlights = [
            ...(t.highlights ?? []),
            { start: p.start, end: p.end, quote: p.quote, card: res.card },
          ];
          onTurns([...turnsRef.current]);
        }
        window.getSelection()?.removeAllRanges();
        setSheetOpen(false);
        setPending(null);
      } catch {
        setError('Could not put that in the journal.');
      } finally {
        setSaving(false);
      }
    },
    // convRef/turnsRef are refs; onTurns is a setState — all stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { pending, sheetOpen, saving, error, openSheet, cancel, save };
}
