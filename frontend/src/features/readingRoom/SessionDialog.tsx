import { useEffect, useState, type KeyboardEvent } from 'react';
import { Sheet } from '../../ui';
import styles from './RosterPage.module.css';

/** Sheet for create/edit — name field + the diary switch. Journal defaults
 * OFF: the diary is the pinned Keeper session's door; turning it on
 * elsewhere is deliberate and rare. */
export function SessionDialog({
  open,
  title,
  initial = '',
  initialJournal = false,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial?: string;
  initialJournal?: boolean;
  onClose: () => void;
  onSave: (name: string, journal: boolean) => void;
}) {
  const [name, setName] = useState(initial);
  const [journal, setJournal] = useState(initialJournal);

  useEffect(() => {
    if (open) {
      setName(initial);
      setJournal(initialJournal);
    }
    // Re-seed when the sheet opens, not as parent state refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    const clean = name.trim();
    if (clean) onSave(clean, journal);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <div className={styles.dialogBody}>
        <input
          autoFocus
          type="text"
          className={styles.dialogInput}
          placeholder="Session name"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <label className={styles.dialogToggle}>
          <input type="checkbox" checked={journal} onChange={(e) => setJournal(e.target.checked)} />
          <span>
            Journal this session
            <span className={styles.dialogToggleDesc}>
              Off by default — only the Keeper session writes to the diary. Turn
              on deliberately, and rarely.
            </span>
          </span>
        </label>
        <button type="button" className={styles.dialogSave} onClick={save}>
          Save
        </button>
      </div>
    </Sheet>
  );
}
