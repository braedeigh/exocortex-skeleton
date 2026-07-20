import { useRef, useState } from 'react';
import { Button, Checkbox, Sheet, TapRow } from '../../ui';
import { companionToPrompt, visibleReminders } from './reminderMath';
import type { ReminderState } from './reminderMath';
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
  onOpenDetail: (item: TodoItem) => void;
  onLog: (date: string, type: string) => void;
  onUndo: (date: string, type: string) => void;
  onSnooze: (id: string, days: number) => void;
}

interface RecentRow {
  kind: 'recent';
  reminder: ReminderDef;
}

interface DueRow {
  kind: 'due';
  reminder: ReminderDef;
  state: ReminderState;
}

const TONE_CLASS: Record<string, string> = {
  red: styles.toneRed,
  orange: styles.toneOrange,
  ongoing: styles.toneOngoing,
};

/**
 * The one attention surface at the top of the page: everything that needs
 * her today, whatever its species — due/overdue recurring reminders (sheets,
 * estradiol…) as loggable rows, then overdue + due-today to-dos. To-do items
 * also stay in their ladder sections below; this is a digest, not a move.
 * Reminder rows keep the full reminder machinery — ✓ logs today (with the
 * 6s undo window and companion prompt), tapping the label opens a sheet
 * with Yesterday / snooze. Renders nothing when nothing needs attention.
 */
export function UpNowCard({
  items,
  reminders,
  activityLog,
  serverDate,
  timeOfDay,
  onToggle,
  onOpenDetail,
  onLog,
  onUndo,
  onSnooze,
}: UpNowCardProps) {
  const [recent, setRecent] = useState<Record<string, string>>({});
  const [actionTarget, setActionTarget] = useState<DueRow | null>(null);
  const [companion, setCompanion] = useState<{ reminder: ReminderDef; date: string } | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const visibleMap = new Map(
    visibleReminders(reminders, activityLog, serverDate, timeOfDay).map((v) => [v.reminder.type, v.state]),
  );

  const reminderRows = reminders
    .map((r): RecentRow | DueRow | null => {
      if (recent[r.type]) return { kind: 'recent', reminder: r };
      const state = visibleMap.get(r.type);
      if (!state) return null;
      return { kind: 'due', reminder: r, state };
    })
    .filter((r): r is RecentRow | DueRow => r !== null);

  if (!reminderRows.length && !items.length) return null;

  function clearRecent(type: string) {
    setRecent((cur) => {
      const next = { ...cur };
      delete next[type];
      return next;
    });
  }

  function logDone(r: ReminderDef, date: string) {
    const comp = companionToPrompt(reminders, activityLog, r.type, date);
    onLog(date, r.type);
    setRecent((cur) => ({ ...cur, [r.type]: date }));
    if (timers.current[r.type]) clearTimeout(timers.current[r.type]);
    timers.current[r.type] = setTimeout(() => clearRecent(r.type), 6000);
    if (comp) setCompanion({ reminder: comp, date });
  }

  function logYesterday(r: ReminderDef) {
    const d = new Date(`${serverDate}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    logDone(r, date);
  }

  function undo(r: ReminderDef) {
    const date = recent[r.type];
    clearRecent(r.type);
    if (date) onUndo(date, r.type);
  }

  function reminderName(r: ReminderDef) {
    return `${r.emoji ? `${r.emoji} ` : ''}${r.label}`;
  }

  return (
    <div className={styles.card}>
      <div className={styles.title}>&#9889; Up now</div>

      {reminderRows.map((row) =>
        row.kind === 'recent' ? (
          <div className={styles.row} key={row.reminder.id}>
            <Checkbox
              className={styles.check}
              checked
              onChange={() => undo(row.reminder)}
              aria-label={`Undo: ${row.reminder.label}`}
            />
            <span className={styles.loggedText}>{reminderName(row.reminder)} logged</span>
            <button type="button" className={styles.undoBtn} onClick={() => undo(row.reminder)}>
              Undo
            </button>
          </div>
        ) : (
          <div className={styles.row} key={row.reminder.id}>
            <Checkbox
              className={styles.check}
              checked={false}
              onChange={() => logDone(row.reminder, serverDate)}
              aria-label={`Log ${row.reminder.label} done today`}
            />
            <button type="button" className={styles.text} onClick={() => setActionTarget(row)}>
              {reminderName(row.reminder)}
            </button>
            <span className={`${styles.due} ${TONE_CLASS[row.state.tone || ''] || ''}`}>
              {row.state.daysText}
            </span>
          </div>
        ),
      )}

      {items.map((it) => {
        const overdue = isOverdue(it.due_by, serverDate);
        return (
          <div className={styles.row} key={it.id}>
            <Checkbox
              className={styles.check}
              checked={it.done}
              onChange={() => onToggle(it.id)}
              aria-label={`Done: ${it.text}`}
            />
            <button type="button" className={styles.text} onClick={() => onOpenDetail(it)}>
              {it.text}
            </button>
            <span className={`${styles.due} ${overdue ? styles.overdue : ''}`}>
              {overdue ? `overdue · ${fmtAddedDate(it.due_by)}` : 'today'}
            </span>
          </div>
        );
      })}

      <Sheet
        open={!!actionTarget}
        title={actionTarget ? `${reminderName(actionTarget.reminder)} — ${actionTarget.state.sub || actionTarget.state.daysText || ''}` : ''}
        onClose={() => setActionTarget(null)}
      >
        <TapRow
          onClick={() => {
            if (actionTarget) logYesterday(actionTarget.reminder);
            setActionTarget(null);
          }}
        >
          &#10003; Did it yesterday
        </TapRow>
        {[
          [3, 'Remind me in 3 days'],
          [7, 'Remind me in 1 week'],
          [14, 'Remind me in 2 weeks'],
        ].map(([days, label]) => (
          <TapRow
            key={label}
            onClick={() => {
              if (actionTarget) onSnooze(actionTarget.reminder.id, days as number);
              setActionTarget(null);
            }}
          >
            &#128164; {label}
          </TapRow>
        ))}
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
