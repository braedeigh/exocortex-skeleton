import { useRef, useState } from 'react';
import { useDismiss } from '../../shell/useDismiss';
import { NotesPanel } from './NotesPanel';
import type { NotesPillKind } from './useNotesPill';
import { readStoredSort, writeStoredSort, type SortDir } from './noteHelpers';
import styles from './NotesPill.module.css';

export interface NotesPillProps {
  onError: (message: string) => void;
}

/**
 * Floating corner pill — React port of static/js/notes-pill.js +
 * static/js/mini-notes.js. Closed: two 46px squares (📝 dev notes / 💡
 * ideas) fixed bottom-right. Clicking one replaces the pill in place with a
 * floating panel (NotesPanel); the tab acted on is always 'today' (see
 * useNotesPill.ts). Only mounted on the native /todos page — the legacy
 * iframe tabs still load the original scripts for the pill.
 */
export function NotesPill({ onError }: NotesPillProps) {
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
        sort={sort}
        onToggleSort={toggleSort}
        onClose={close}
        onError={onError}
      />
    );
  }

  return (
    <div className={styles.pill} ref={containerRef}>
      <button
        type="button"
        className={`${styles.sq} ${styles.sqDev}`}
        title="Dev notes"
        aria-label="Dev notes"
        onClick={() => setOpenKind('dev')}
      >
        &#128221;
      </button>
      <button
        type="button"
        className={styles.sq}
        title="Ideas"
        aria-label="Ideas"
        onClick={() => setOpenKind('idea')}
      >
        &#128161;
      </button>
    </div>
  );
}
