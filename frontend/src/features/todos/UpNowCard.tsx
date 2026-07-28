import { useState } from 'react';
import { Button, Checkbox, Sheet, TapRow } from '../../ui';
import { companionToPrompt, visibleReminders } from './reminderMath';
import { fmtAddedDate, isOverdue } from './todoHelpers';
import type { ActivityEntry, ReminderDef, TimeOfDay, TodoItem } from './types';
import styles from './UpNowCard.module.css';

export interface UpNowCardProps {
  items: TodoItem[];
  reminders: ReminderDef[];
  activityLog: ActivityEntry[];
  serverDate: string;
  timeOfDay: TimeOfDay;
  onToggle: (id: string) => void;
  onSubtaskToggle: (parentId: string, subId: string) => void;
  onOpenDetail: (item: TodoItem) => void;
  onLog: (date: string, type: string) => void;
  onUndo: (date: string, type: string) => void;
  onSnooze: (id: string, days: number) => void;
  onUpdateReminder: (id: string, patch: Partial<ReminderDef>) => void;
}

const TONE_CLASS: Record<string, string> = {
  red: styles.toneRed,
  orange: styles.toneOrange,
  ongoing: styles.toneOngoing,
};

const SUBS_OPEN_PREFIX = 'upNowSubsOpen:';

/** Whether this item's subtask list was last left open. Defaults to open, so
 * a brand-new multi-part errand shows its pieces without being hunted for. */
function readSubsOpen(id: string): boolean {
  try {
    const v = localStorage.getItem(SUBS_OPEN_PREFIX + id);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return true;
}

/**
 * The one attention surface at the top of the page: everything that needs
 * her today — due/overdue recurring reminders (marked 🔁) and overdue +
 * due-today to-dos. Checked things don't vanish: they sink to the bottom,
 * struck through, until the day rolls over (to-dos via the backend's
 * morning sweep; logged reminders shown while their log entry is today's,
 * where unchecking IS the undo). Tapping a reminder's label opens its
 * control-room sheet: did-it-yesterday, snooze stepper, and the repeat
 * cadence stepper (saved to the reminder definition). To-do items also stay
 * in their ladder sections below; this is a digest, not a move. Renders
 * nothing when nothing needs attention.
 *
 * A still-open to-do shows its subtasks inline underneath, each tickable
 * right here — so a multi-part errand ("Amazon order" → trash can, spray
 * bottles, hangers) can be worked from this card without opening the detail
 * sheet. Done subtasks stay visible struck through, matching how the card
 * treats checked-off rows. Completed parents don't list their subtasks —
 * once the whole thing is done the breakdown is just noise.
 *
 * Each subtask list collapses behind a chevron on its parent row, remembered
 * per item in localStorage so it survives a refresh. Collapsing still shows
 * the count of what's left, so folding a long errand away never hides the
 * fact that it's unfinished. Lists start open — a new errand shouldn't have
 * to be hunted for.
 * (Prompts: "edit the Up now tab to be able to show sub items, currently it
 * does not display them." / "make it such that i can collapse the sub
 * to-dos.")
 */
export function UpNowCard({
  items,
  reminders,
  activityLog,
  serverDate,
  timeOfDay,
  onToggle,
  onSubtaskToggle,
  onOpenDetail,
  onLog,
  onUndo,
  onSnooze,
  onUpdateReminder,
}: UpNowCardProps) {
  const [actionId, setActionId] = useState<string | null>(null);
  const [snoozeDays, setSnoozeDays] = useState(3);
  const [companion, setCompanion] = useState<{ reminder: ReminderDef; date: string } | null>(null);
  // Overlays localStorage: an id only lands here once she's toggled it this
  // session, so untouched items keep answering from what was saved.
  const [subsOpen, setSubsOpen] = useState<Record<string, boolean>>({});

  const isSubsOpen = (id: string) => subsOpen[id] ?? readSubsOpen(id);

  function toggleSubs(id: string) {
    const next = !isSubsOpen(id);
    setSubsOpen((m) => ({ ...m, [id]: next }));
    try {
      localStorage.setItem(SUBS_OPEN_PREFIX + id, next ? '1' : '0');
    } catch {
      // state just won't persist
    }
  }

  const loggedToday = new Set(
    activityLog.filter((e) => e.date === serverDate).map((e) => e.type),
  );

  const dueRows = visibleReminders(reminders, activityLog, serverDate, timeOfDay).filter(
    (v) => !loggedToday.has(v.reminder.type),
  );
  const loggedRows = reminders.filter(
    (r) => (r.mode || 'log') !== 'track' && loggedToday.has(r.type),
  );

  // Live lookup so the sheet's steppers show the post-edit value, not the
  // stale copy captured when the sheet was opened.
  const target = actionId ? reminders.find((r) => r.id === actionId) || null : null;
  const targetState = actionId ? dueRows.find((v) => v.reminder.id === actionId)?.state : undefined;

  if (!dueRows.length && !loggedRows.length && !items.length) return null;

  function logDone(r: ReminderDef, date: string) {
    const comp = companionToPrompt(reminders, activityLog, r.type, date);
    onLog(date, r.type);
    if (comp) setCompanion({ reminder: comp, date });
  }

  function logYesterday(r: ReminderDef) {
    const d = new Date(`${serverDate}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    logDone(r, date);
  }

  function openSheet(id: string) {
    setSnoozeDays(3);
    setActionId(id);
  }

  function reminderName(r: ReminderDef) {
    return `${r.emoji ? `${r.emoji} ` : ''}${r.label}`;
  }

  const everyDays = target?.every_days ?? 3;

  return (
    <div className={styles.card}>
      <div className={styles.title}>&#9889; Up now</div>

      {dueRows.map(({ reminder: r, state }) => (
        <div className={styles.row} key={r.id}>
          <Checkbox
            className={styles.check}
            checked={false}
            onChange={() => logDone(r, serverDate)}
            aria-label={`Log ${r.label} done today`}
            data-track="reminder-log"
          />
          <button type="button" className={styles.text} onClick={() => openSheet(r.id)}>
            {reminderName(r)}
          </button>
          <span className={`${styles.due} ${TONE_CLASS[state.tone || ''] || ''}`}>
            &#128257; {state.daysText}
          </span>
        </div>
      ))}

      {items.filter((it) => !it.done).map((it) => {
        const overdue = isOverdue(it.due_by, serverDate);
        const subs = it.subtasks || [];
        const open = isSubsOpen(it.id);
        const remaining = subs.filter((s) => !s.done).length;
        return (
          <div className={styles.itemBlock} key={it.id}>
            <div className={styles.row}>
              <Checkbox
                className={styles.check}
                checked={false}
                onChange={() => onToggle(it.id)}
                aria-label={`Done: ${it.text}`}
                data-track="todo-complete"
              />
              <button type="button" className={styles.text} onClick={() => onOpenDetail(it)} data-track="todo-open">
                {it.text}
              </button>
              {subs.length ? (
                <button
                  type="button"
                  className={styles.subToggle}
                  aria-expanded={open}
                  aria-label={
                    open
                      ? `Collapse subtasks for ${it.text}`
                      : `Expand ${remaining} remaining subtasks for ${it.text}`
                  }
                  onClick={() => toggleSubs(it.id)}
                  data-track="todo-subtasks-toggle"
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  <span className={styles.subCount}>{remaining}</span>
                </button>
              ) : null}
              <span className={`${styles.due} ${overdue ? styles.overdue : ''}`}>
                {overdue ? `overdue · ${fmtAddedDate(it.due_by)}` : 'today'}
              </span>
            </div>
            {subs.length && open ? (
              <div className={styles.subtasks}>
                {subs.map((sub) => (
                  <div key={sub.id} className={styles.subtaskRow}>
                    <Checkbox
                      className={styles.subtaskCheckbox}
                      checked={sub.done}
                      onChange={() => onSubtaskToggle(it.id, sub.id)}
                      aria-label={sub.done ? `Mark ${sub.text} not done` : `Mark ${sub.text} done`}
                      data-track="todo-subtask-toggle"
                    />
                    <span className={`${styles.subtaskText} ${sub.done ? styles.subtaskDone : ''}`}>
                      {sub.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {items.filter((it) => it.done).map((it) => (
        <div className={styles.row} key={it.id}>
          <Checkbox
            className={styles.check}
            checked
            onChange={() => onToggle(it.id)}
            aria-label={`Mark ${it.text} not done`}
            data-track="todo-complete"
          />
          <button
            type="button"
            className={`${styles.text} ${styles.doneText}`}
            onClick={() => onOpenDetail(it)}
            data-track="todo-open"
          >
            {it.text}
          </button>
          <span className={`${styles.due} ${styles.doneChip}`}>done</span>
        </div>
      ))}

      {loggedRows.map((r) => (
        <div className={styles.row} key={r.id}>
          <Checkbox
            className={styles.check}
            checked
            onChange={() => onUndo(serverDate, r.type)}
            aria-label={`Undo today's ${r.label} log`}
            data-track="reminder-log"
          />
          <button
            type="button"
            className={`${styles.text} ${styles.doneText}`}
            onClick={() => openSheet(r.id)}
          >
            {reminderName(r)}
          </button>
          <span className={`${styles.due} ${styles.doneChip}`}>&#128257; logged</span>
        </div>
      ))}

      <Sheet
        open={!!target}
        title={target ? `${reminderName(target)}${targetState?.sub ? ` — ${targetState.sub}` : ''}` : ''}
        onClose={() => setActionId(null)}
      >
        {target ? (
          <>
            <TapRow
              onClick={() => {
                logYesterday(target);
                setActionId(null);
              }}
            >
              &#10003; Did it yesterday
            </TapRow>

            <div className={styles.stepperBlock}>
              <div className={styles.stepperLabel}>&#128164; Remind me later</div>
              <div className={styles.stepperControls}>
                <button
                  type="button"
                  className={styles.stepBtn}
                  aria-label="Fewer days"
                  onClick={() => setSnoozeDays((d) => Math.max(1, d - 1))}
                >
                  &minus;
                </button>
                <span className={styles.stepValue}>
                  {snoozeDays} day{snoozeDays !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  className={styles.stepBtn}
                  aria-label="More days"
                  onClick={() => setSnoozeDays((d) => d + 1)}
                >
                  +
                </button>
                <Button
                  variant="primary"
                  data-track="reminder-snooze"
                  onClick={() => {
                    onSnooze(target.id, snoozeDays);
                    setActionId(null);
                  }}
                >
                  Snooze
                </Button>
              </div>
            </div>

            {(target.schedule || 'interval') === 'interval' ? (
            <div className={styles.stepperBlock}>
              <div className={styles.stepperLabel}>&#128257; Repeats every</div>
              <div className={styles.stepperControls}>
                <button
                  type="button"
                  className={styles.stepBtn}
                  aria-label="Repeat less often"
                  onClick={() => onUpdateReminder(target.id, { every_days: Math.max(1, everyDays - 1) })}
                >
                  &minus;
                </button>
                <span className={styles.stepValue}>
                  {everyDays} day{everyDays !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  className={styles.stepBtn}
                  aria-label="Repeat more often"
                  onClick={() => onUpdateReminder(target.id, { every_days: everyDays + 1 })}
                >
                  +
                </button>
              </div>
              <div className={styles.stepperHint}>Saved to the reminder — changes stick.</div>
            </div>
            ) : null}
          </>
        ) : null}
      </Sheet>

      <Sheet open={!!companion} title="Also log?" onClose={() => setCompanion(null)}>
        {companion ? (
          <>
            <p>
              Did you also do <b>{companion.reminder.label}</b>?
            </p>
            <div className={styles.companionActions}>
              <Button variant="secondary" onClick={() => setCompanion(null)}>
                No
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onLog(companion.date, companion.reminder.type);
                  setCompanion(null);
                }}
              >
                Yes
              </Button>
            </div>
          </>
        ) : null}
      </Sheet>
    </div>
  );
}
