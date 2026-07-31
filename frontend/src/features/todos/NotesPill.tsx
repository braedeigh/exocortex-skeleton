import { useRef, useState } from 'react';
import { useDismiss } from '../../shell/useDismiss';
import { NotesPanel } from './NotesPanel';
import type { NotesPillKind } from './useNotesPill';
import { readStoredSort, writeStoredSort, type SortDir } from './noteHelpers';
import styles from './NotesPill.module.css';

export interface NotesPillProps {
  onError: (message: string) => void;
  /** Which page's notes the pill acts on. */
  tab?: string;
  /** Hide the panel's "All ↗" link (pointless on /notes itself). */
  showAllLink?: boolean;
  /** Extra class on the closed pill — pages with their own bottom furniture
   * (e.g. the thread page's sticky composer) use it to lift the pill clear. */
  className?: string;
  /** Which bottom corner to sit in. 'left' is for a page rendered inside the
   * desktop split's left pane, where the right corner already holds the other
   * pane's pill. Moves the open panel too, so the panel appears where the
   * button was rather than across the window. */
  anchor?: 'right' | 'left';
}

/**
 * Floating corner pill — React port of static/js/notes-pill.js +
 * static/js/mini-notes.js. Closed: two 46px squares (📝 dev notes / 💡
 * ideas) fixed bottom-right. Clicking one replaces the pill in place with a
 * floating panel (NotesPanel) acting on `tab`'s notes. Mounted on the
 * native pages (/todos as 'today', /notes as 'notes') — the legacy iframe
 * tabs still load the original scripts for the pill.
 */
export function NotesPill({
  onError,
  tab = 'today',
  showAllLink = true,
  className,
  anchor = 'right',
}: NotesPillProps) {
  const anchorClass = anchor === 'left' ? styles.anchorLeft : undefined;
  const [openKind, setOpenKind] = useState<NotesPillKind | null>(null);
  const [sort, setSort] = useState<SortDir>(readStoredSort);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = () => setOpenKind(null);
  useDismiss(openKind !== null, close, containerRef);

  function toggleSort() {
    setSort((cur) => {
      const next: SortDir = cur === 'newest' ? 'oldest' : 'newest';
      writeStoredSort(next);
      return next;
    });
  }

  if (openKind) {
    return (
      <NotesPanel
        ref={containerRef}
        kind={openKind}
        tab={tab}
        showAllLink={showAllLink}
        sort={sort}
        onToggleSort={toggleSort}
        onClose={close}
        onError={onError}
        className={anchorClass}
      />
    );
  }

  return (
    <div
      className={[styles.pill, anchorClass, className].filter(Boolean).join(' ')}
      ref={containerRef}
    >
      <button
        type="button"
        className={`${styles.sq} ${styles.sqDev}`}
        title="Dev notes"
        aria-label="Dev notes"
        onClick={() => setOpenKind('dev')}
        data-track="todo-notes-dev"
      >
        &#128221;
      </button>
      <button
        type="button"
        className={styles.sq}
        title="Ideas"
        aria-label="Ideas"
        onClick={() => setOpenKind('idea')}
        data-track="todo-notes-ideas"
      >
        &#128161;
      </button>
    </div>
  );
}
