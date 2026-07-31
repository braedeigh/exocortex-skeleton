import { useEffect, useState, type KeyboardEvent } from 'react';
import { Sheet } from '../../ui';
import type { Lane } from './api';
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

/** What the dialog hands back. `actGate: null` means "follow the lane" — the
 * distinction between a choice she made and a value it inherited, which is
 * what lets a later lane change still re-scope the session. */
export interface SessionDraft {
  name: string;
  journal: boolean;
  model: string;
  lane: Lane;
  actGate: boolean | null;
}

const LANE_BLURB: Record<Lane, string> = {
  orchestra: 'Rooted in the app code. Stops and asks before anything irreversible.',
  personal: 'Rooted where both repos meet. Just acts — you’re the one watching.',
};

/**
 * Sheet for create/edit — name, model, lane, the asks-first override, and the
 * diary switch.
 *
 * The room is a real picker in BOTH modes, but it doesn't mean the same thing
 * in each, so the blurb under it changes. On CREATE it's the live choice (there
 * used to be a '+' per lane that made it implicitly; now one floating '+' makes
 * it explicit) and it fixes `cwd` — where the session runs — permanently. On
 * EDIT it only re-scopes the safety nets from the next turn on; `cwd` is
 * already set and the backend can't move it.
 *
 * Journal defaults OFF: the diary is the pinned Keeper session's door. Model
 * defaults to '' = inherit the CLI default.
 */
export function SessionDialog({
  open,
  title,
  initial = '',
  initialJournal = false,
  initialModel = '',
  lane,
  editable = false,
  initialActGate = null,
  modelChoices = [],
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial?: string;
  initialJournal?: boolean;
  initialModel?: string;
  /** The lane being created into, or the session's current one when editing. */
  lane: Lane;
  /** True when editing an existing session — unlocks the lane picker. */
  editable?: boolean;
  /** null = following the lane default. */
  initialActGate?: boolean | null;
  modelChoices?: string[];
  onClose: () => void;
  onSave: (draft: SessionDraft) => void;
}) {
  const [name, setName] = useState(initial);
  const [journal, setJournal] = useState(initialJournal);
  const [model, setModel] = useState(initialModel);
  const [pickedLane, setPickedLane] = useState<Lane>(lane);
  const [actGate, setActGate] = useState<boolean | null>(initialActGate);

  useEffect(() => {
    if (open) {
      setName(initial);
      setJournal(initialJournal);
      setModel(initialModel);
      setPickedLane(lane);
      setActGate(initialActGate);
    }
    // Re-seed when the sheet opens, not as parent state refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    const clean = name.trim();
    if (clean) onSave({ name: clean, journal, model, lane: pickedLane, actGate });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  // What the gate will actually DO once saved — resolved here so the label
  // never says "default" without saying what the default resolves to.
  const gateOn = actGate === null ? pickedLane === 'orchestra' : actGate;

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

        <label className={styles.dialogField}>
          Room
          <select
            className={styles.dialogSelect}
            value={pickedLane}
            onChange={(e) => setPickedLane(e.target.value as Lane)}
          >
            <option value="orchestra">Orchestra</option>
            <option value="personal">Personal</option>
          </select>
          <span className={styles.dialogFieldDesc}>
            {LANE_BLURB[pickedLane]}{' '}
            {editable
              ? 'Moving rooms changes that from the next turn on — it does not move where the session runs, which is fixed when it’s created.'
              : 'This also fixes where the session runs, for good — that part can’t be changed later.'}
          </span>
        </label>

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

        <label className={styles.dialogField}>
          Asks first
          <select
            className={styles.dialogSelect}
            value={actGate === null ? '' : actGate ? 'on' : 'off'}
            onChange={(e) => {
              const v = e.target.value;
              setActGate(v === '' ? null : v === 'on');
            }}
          >
            <option value="">Follow the room ({gateOn ? 'asks' : 'just acts'})</option>
            <option value="on">Always ask</option>
            <option value="off">Never ask</option>
          </select>
          <span className={styles.dialogFieldDesc}>
            Whether it stops and raises an orange card before something
            irreversible. Orchestra asks because nobody&rsquo;s watching;
            Personal doesn&rsquo;t because you are.
          </span>
        </label>

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
