import { useEffect, useRef, useState } from 'react';
import { useSaveCarNotes } from './useCarData';
import styles from './CarNotesCard.module.css';

/**
 * Free-form notepad card — port of renderCarNotes/carNotesDirty/carNotesSave
 * in static/js/car.js. Typing marks it "unsaved…", blur saves, and the status
 * line walks saving… → saved / save failed. While the textarea is focused or
 * dirty the 5s poll never clobbers the draft (the old core.js render loop
 * preserved the focused field the same way).
 */
export function CarNotesCard({ serverText }: { serverText: string }) {
  const [draft, setDraft] = useState(serverText);
  const [dirty, setDirty] = useState(false);
  const focusedRef = useRef(false);
  const save = useSaveCarNotes();

  useEffect(() => {
    if (!dirty && !focusedRef.current) setDraft(serverText);
  }, [serverText, dirty]);

  const status = dirty
    ? 'unsaved…'
    : save.isPending
      ? 'saving…'
      : save.isError
        ? 'save failed'
        : save.isSuccess
          ? 'saved'
          : '';

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.title}>Notes</div>
        <div className={styles.status} aria-live="polite">
          {status}
        </div>
      </div>
      <textarea
        className={styles.textarea}
        rows={5}
        placeholder="Save thoughts about the car here…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          setDirty(false);
          save.mutate(draft);
        }}
        aria-label="Car notes"
      />
    </div>
  );
}
