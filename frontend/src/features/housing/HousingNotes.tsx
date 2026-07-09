import { useRef, useState } from 'react';
import { useSaveNotes } from './useHousingData';
import styles from './HousingNotes.module.css';

export interface HousingNotesProps {
  /** Server copy of the notes blob (housing.notes). */
  notes: string;
}

type SaveStatus = '' | 'unsaved…' | 'saving…' | 'saved' | 'save failed';

/**
 * "Criteria & plan" box — port of renderHousingNotes(): free-text criteria +
 * move-timing plan, dirty on input, saved on blur, with the little
 * unsaved…/saving…/saved status readout in the corner.
 *
 * While she's typing, the textarea shows a local draft so the 5s poll can't
 * clobber keystrokes; the draft clears once a save round-trips.
 */
export function HousingNotes({ notes }: HousingNotesProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('');
  // Mirror of `draft` for the async save callbacks — if she typed more while
  // the POST was in flight, keep the newer draft instead of clearing it.
  const draftRef = useRef<string | null>(null);
  const save = useSaveNotes();

  function handleChange(text: string) {
    setDraft(text);
    draftRef.current = text;
    setStatus('unsaved…');
  }

  function handleBlur() {
    if (draftRef.current === null) return;
    setStatus('saving…');
    save.mutate(draftRef.current, {
      onSuccess: (_res, savedText) => {
        if (draftRef.current === savedText) {
          draftRef.current = null;
          setDraft(null);
        }
        setStatus('saved');
      },
      onError: () => setStatus('save failed'),
    });
  }

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.title}>Criteria &amp; plan</div>
        <div className={styles.status}>{status}</div>
      </div>
      <textarea
        className={styles.textarea}
        rows={7}
        value={draft ?? notes}
        placeholder="What you're looking for, move timing, dealbreakers&hellip;"
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
    </div>
  );
}
