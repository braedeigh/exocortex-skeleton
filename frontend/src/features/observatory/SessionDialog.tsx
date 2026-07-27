import { useEffect, useState, type KeyboardEvent } from 'react';
import { Sheet } from '../../ui';
import styles from './RosterPage.module.css';

/** Display names for the model aliases the server offers. Anything not
 * listed falls back to the raw alias, so the server can add a choice without
 * a frontend change (it just shows up unprettified). */
const MODEL_LABELS: Record<string, string> = {
  fable: 'Fable',
  opus: 'Opus',
  'opus[1m]': 'Opus (1M context)',
  sonnet: 'Sonnet',
  'sonnet[1m]': 'Sonnet (1M context)',
  haiku: 'Haiku',
};

/** Sheet for create/edit — name field, model picker, the diary switch.
 * Journal defaults OFF: the diary is the pinned Keeper session's door;
 * turning it on elsewhere is deliberate and rare. Model defaults to '' =
 * inherit the CLI default, which is where every session starts. */
export function SessionDialog({
  open,
  title,
  initial = '',
  initialJournal = false,
  initialModel = '',
  modelChoices = [],
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial?: string;
  initialJournal?: boolean;
  initialModel?: string;
  modelChoices?: string[];
  onClose: () => void;
  onSave: (name: string, journal: boolean, model: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [journal, setJournal] = useState(initialJournal);
  const [model, setModel] = useState(initialModel);

  useEffect(() => {
    if (open) {
      setName(initial);
      setJournal(initialJournal);
      setModel(initialModel);
    }
    // Re-seed when the sheet opens, not as parent state refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    const clean = name.trim();
    if (clean) onSave(clean, journal, model);
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
        {modelChoices.length > 0 && (
          <label className={styles.dialogField}>
            Model
            <select
              className={styles.dialogSelect}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Default</option>
              {modelChoices.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m] ?? m}
                </option>
              ))}
            </select>
            <span className={styles.dialogFieldDesc}>
              Default follows whatever `claude` itself is set to. A pick here
              applies from the next turn on — the conversation carries over.
            </span>
          </label>
        )}
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
