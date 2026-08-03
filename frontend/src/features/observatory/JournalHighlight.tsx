import { useEffect, useRef, useState } from 'react';
import styles from './ObservatoryPage.module.css';

/**
 * JournalHighlight.tsx — the two things she sees when she highlights something
 * in a conversation: a ✦ pill that floats up next to the selection, and the
 * sheet it opens to keep the span (with a note, if she wants one).
 *
 * The pill is the whole gesture — one tap from selection to saved. The note is
 * offered, never charged: Keep works with the field empty, and an empty note
 * mints nothing extra. So the fast path stays two taps and the thoughtful path
 * is right there without being in the way.
 *
 * Deliberately the same ✦ and the same pill shape as the whole-reply
 * "put this in the journal" button (replyViews.tsx) — one gesture family with
 * two grains, not two systems that happen to both save things.
 *
 * State lives in ObservatoryPage.tsx (which owns the selection listener and the
 * save); this file is the surface. Position comes from
 * highlightMarks.selectionAnchorPoint.
 *
 * Prompt: "if I highlight something a little tap comes up for me to put that in
 * my journal ... and I want to be able to annotate it."
 */

export const PILL_WIDTH = 132;
export const PILL_HEIGHT = 40;

export function HighlightPill({
  left,
  top,
  onTap,
}: {
  left: number;
  top: number;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.highlightPill}
      style={{ left, top, width: PILL_WIDTH, height: PILL_HEIGHT }}
      // mousedown, not click: a click would land after the browser had already
      // cleared the selection out from under it on some surfaces, and the
      // selection IS the thing being acted on.
      onMouseDown={(e) => {
        e.preventDefault();
        onTap();
      }}
      onTouchStart={(e) => {
        e.preventDefault();
        onTap();
      }}
    >
      ✦ journal
    </button>
  );
}

export function HighlightSheet({
  quote,
  saving,
  error,
  onSave,
  onCancel,
}: {
  quote: string;
  saving: boolean;
  error: string | null;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the note without stealing the first paint — she may just want Keep.
  useEffect(() => {
    const id = window.setTimeout(() => areaRef.current?.focus(), 120);
    return () => window.clearTimeout(id);
  }, []);

  // Escape backs out; ⌘/Ctrl+Enter keeps. The plain Enter key stays a newline —
  // a note is prose, not a search box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(note);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [note, onSave, onCancel]);

  return (
    <div
      className={styles.highlightOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={styles.highlightSheet} role="dialog" aria-label="Put this in the journal">
        <div className={styles.highlightQuote}>{quote}</div>
        <textarea
          ref={areaRef}
          className={styles.highlightNote}
          value={note}
          rows={3}
          placeholder="a note, if you want one"
          onChange={(e) => setNote(e.target.value)}
        />
        {error ? <div className={styles.highlightError}>{error}</div> : null}
        <div className={styles.highlightBtns}>
          <button type="button" className={styles.highlightCancel} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.highlightKeep}
            onClick={() => onSave(note)}
            disabled={saving}
          >
            {saving ? 'keeping…' : '✦ Keep'}
          </button>
        </div>
      </div>
    </div>
  );
}
