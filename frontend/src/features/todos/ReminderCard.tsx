import { useRef, useState } from 'react';
import { Button, Sheet, TapRow } from '../../ui';
import { companionToPrompt, visibleReminders } from './reminderMath';
import type { ReminderState } from './reminderMath';
import type { ActivityEntry, ReminderDef, TimeOfDay } from './types';
import styles from './ReminderCard.module.css';

export interface ReminderCardProps {
  reminders: ReminderDef[];
  activityLog: ActivityEntry[];
  serverDate: string;
  timeOfDay: TimeOfDay;
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

export function ReminderCard({ reminders, activityLog, serverDate, timeOfDay, onLog, onUndo, onSnooze }: ReminderCardProps) {
  const [recent, setRecent] = useState<Record<string, string>>({});
  const [snoozeTarget, setSnoozeTarget] = useState<ReminderDef | null>(null);
  const [companion, setCompanion] = useState<{ reminder: ReminderDef; date: string } | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const visibleMap = new Map(
    visibleReminders(reminders, activityLog, serverDate, timeOfDay).map((v) => [v.reminder.type, v.state]),
  );

  const rows = reminders
    .map((r): RecentRow | DueRow | null => {
      if (recent[r.type]) return { kind: 'recent', reminder: r };
      const state = visibleMap.get(r.type);
      if (!state) return null;
      return { kind: 'due', reminder: r, state };
    })
    .filter((r): r is RecentRow | DueRow => r !== null);

  if (!rows.length) return null;

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

  return (
    <div className={styles.wrap}>
      {rows.map((row) =>
        row.kind === 'recent' ? (
          <div key={row.reminder.id} className={`${styles.bar} ${styles['tone-green']}`}>
            <div className={styles.info}>
              <div className={styles.headline}>
                &#10003; {row.reminder.emoji ? `${row.reminder.emoji} ` : ''}
                {row.reminder.label} logged
              </div>
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.actionBtn} onClick={() => undo(row.reminder)}>
                Undo
              </button>
            </div>
          </div>
        ) : (
          <div key={row.reminder.id} className={`${styles.bar} ${styles[`tone-${row.state.tone}`]} ${row.state.pulse ? styles.pulse : ''}`}>
            <div className={styles.info}>
              <div className={styles.headline}>
                {row.reminder.emoji ? `${row.reminder.emoji} ` : ''}
                {row.reminder.label}: {row.state.daysText}
              </div>
              <div className={styles.sub}>{row.state.sub}</div>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.iconBtn}
                title="Remind me later"
                onClick={() => setSnoozeTarget(row.reminder)}
              >
                &#128164;
              </button>
              <button type="button" className={styles.actionBtn} onClick={() => logYesterday(row.reminder)}>
                Yesterday
              </button>
              <button type="button" className={styles.actionBtn} onClick={() => logDone(row.reminder, serverDate)}>
                &#10003; Done
              </button>
            </div>
          </div>
        ),
      )}

      <Sheet open={!!snoozeTarget} title="Remind me again in" onClose={() => setSnoozeTarget(null)}>
        {[
          [3, '3 days'],
          [7, '1 week'],
          [14, '2 weeks'],
        ].map(([days, label]) => (
          <TapRow
            key={label}
            onClick={() => {
              if (snoozeTarget) onSnooze(snoozeTarget.id, days as number);
              setSnoozeTarget(null);
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
            <div className={styles.actions} style={{ marginTop: 'var(--space-4)' }}>
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
