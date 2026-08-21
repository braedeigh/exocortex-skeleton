import { useEffect, useState, type KeyboardEvent } from 'react';
import { Sheet } from '../../ui';
import { LANE_BLURB, LANE_LABEL, ROOMS, isRoom, type Lane } from './api';
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

/**
 * Sheet for create/edit — name, model, lane, the asks-first override, and the
 * diary switch.
 *
 * The room is a real picker in BOTH modes, but it doesn't mean the same thing
 * in each, so the blurb under it changes. On CREATE it fixes `cwd` — where the
 * session runs — permanently. On EDIT it only re-scopes the safety nets from
 * the next turn on; `cwd` is already set and the backend can't move it.
 *
 * THE ROOM IS NEVER GUESSED. `lane` can arrive null, and then the picker opens
 * on "Choose a room…" and the button at the bottom stays dead until she picks
 * one. That's the roomless '+' in the rail: it floats over the whole roster and
 * genuinely cannot know which room she means, and the room decides where the
 * session RUNS, for good — a default there is the sheet quietly making the one
 * irreversible choice on it. So it asks. The per-room '+' on each title line
 * passes its own room in and she never sees the empty state.
 *
 * SAVE IS PINNED TO THE BOTTOM, and says what it will do — "Start session" when
 * creating, "Save changes" when editing. It rides the Sheet's footer slot (the
 * same one the to-do form uses), so the fields scroll under a bar that doesn't:
 * on a phone this sheet is taller than the screen, and a button at the end of a
 * scroll is a button she has to go looking for.
 *
 * Journal defaults OFF: the diary is the pinned Keeper session's door. Model
 * defaults to '' = inherit the CLI default.
 *
 * [prompt: "make it such that i have to select a room. and then on the modal
 * make it such that the save says 'start session' and floats at the bottom
 * fixed"]
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
  /** The lane being created into, or the session's current one when editing.
   * null = nothing chosen yet, so she has to choose before she can start. */
  lane: Lane | null;
  /** True when editing an existing session. The room picker is live either
   * way; this switches what the line under it says the change will DO. */
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
  // '' is the un-chosen state, not a lane. Kept as a falsy sentinel so every
  // gate below ("can she save", "what does the room blurb say") is one check.
  const [pickedLane, setPickedLane] = useState<Lane | ''>(lane ?? '');
  const [actGate, setActGate] = useState<boolean | null>(initialActGate);

  useEffect(() => {
    if (open) {
      setName(initial);
      setJournal(initialJournal);
      setModel(initialModel);
      setPickedLane(lane ?? '');
      setActGate(initialActGate);
    }
    // Re-seed when the sheet opens, not as parent state refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Both things this sheet can't invent for her: a name, and a room. The
  // button reads this rather than each check being restated at the call site.
  const ready = name.trim().length > 0 && pickedLane !== '';

  // `ready` carries the `pickedLane !== ''` narrowing with it, so bailing on it
  // is also what proves to the type checker there's a real lane to hand back.
  const save = () => {
    if (!ready) return;
    onSave({ name: name.trim(), journal, model, lane: pickedLane, actGate });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  // What the gate will actually DO once saved — resolved here so the label
  // never says "default" without saying what the default resolves to. Both
  // rooms she can pick just act; the check still names Orchestra because a
  // session left in that retired lane really does still ask, and the label has
  // to tell the truth about the session in front of her.
  const gateOn = actGate === null ? pickedLane === 'orchestra' : actGate;

  // The rooms on offer, plus the session's own lane when that lane no longer
  // has a room (a leftover Orchestra session). Without it the <select> would
  // sit on a value it doesn't list — showing blank, and quietly rewriting the
  // lane to whatever ended up selected the first time she saved something else.
  // '' isn't a lane and never joins the list; it gets the placeholder option.
  const laneChoices: Lane[] =
    pickedLane === '' || isRoom(pickedLane) ? [...ROOMS] : [...ROOMS, pickedLane];

  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      /* The footer slot turns the Sheet into a column: header pinned, fields
         scrolling, this bar sitting still at the bottom. It already handles the
         phone's home-bar inset, which is the whole reason to reuse it rather
         than float a button of our own down there. */
      footer={
        <button
          type="button"
          className={styles.dialogSave}
          onClick={save}
          disabled={!ready}
          /* Says what it will DO. A dead button with no reason next to it is
             the sheet sulking at her, so the title tells her what's missing. */
          title={
            ready
              ? undefined
              : pickedLane === ''
                ? 'Choose a room first'
                : 'Give it a name first'
          }
        >
          {editable ? 'Save changes' : 'Start session'}
        </button>
      }
    >
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
            {/* Only drawn while nothing is chosen, and it can't be chosen —
                so the empty state is visible but not a thing she can come back
                to and save. */}
            {pickedLane === '' ? (
              <option value="" disabled>
                Choose a room…
              </option>
            ) : null}
            {laneChoices.map((l) => (
              <option key={l} value={l}>
                {LANE_LABEL[l]}
              </option>
            ))}
          </select>
          <span className={styles.dialogFieldDesc}>
            {pickedLane === '' ? (
              'Where this session stands — which decides what it can reach. Pick one to start.'
            ) : (
              <>
                {LANE_BLURB[pickedLane]}{' '}
                {editable
                  ? 'Moving rooms changes that from the next turn on — it does not move where the session runs, which is fixed when it’s created.'
                  : 'This also fixes where the session runs, for good — that part can’t be changed later.'}
              </>
            )}
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
            {/* Names what "follow" actually resolves to — but only once there's
                a room to follow. With none picked it can't know, and a label
                that guesses is worse than one that waits. */}
            <option value="">
              {pickedLane === ''
                ? 'Follow the room'
                : `Follow the room (${gateOn ? 'asks' : 'just acts'})`}
            </option>
            <option value="on">Always ask</option>
            <option value="off">Never ask</option>
          </select>
          <span className={styles.dialogFieldDesc}>
            Whether it stops and raises an orange card before something
            irreversible. Personal and Coding don&rsquo;t ask, because
            you&rsquo;re the one watching — set it here if you want this one to.
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
      </div>
    </Sheet>
  );
}
