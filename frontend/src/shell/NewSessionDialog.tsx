import { useEffect, useState, type KeyboardEvent } from 'react';
import { Sheet } from '../ui';
import styles from './NewSessionDialog.module.css';

/**
 * "When making a new session, make a modal pop up that is new session name
 * rather than native browser" — replaces the old `window.prompt('Session
 * name:')` in SessionBar with the shared Sheet primitive.
 */
export function NewSessionDialog({
  open,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');

  // Fresh field each time the sheet opens.
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Sheet open={open} title="New session" onClose={onClose}>
      <div className={styles.body}>
        <input
          autoFocus
          type="text"
          className={styles.input}
          placeholder="session-name"
          maxLength={30}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {error && <div className={styles.error}>{error}</div>}
        <button type="button" className={styles.createBtn} onClick={submit} disabled={!name.trim()}>
          Create
        </button>
      </div>
    </Sheet>
  );
}
