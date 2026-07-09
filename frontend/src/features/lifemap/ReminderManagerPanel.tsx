import { useState } from 'react';
import type { ReminderDef, ReminderMode, ReminderSchedule, ReminderShape, TimeOfDay } from '../todos/types';
import {
  WEEKDAY_FULL,
  WEEKDAY_LETTER,
  coerceDraftsForSave,
  newDraft,
  seedDrafts,
  toggleTime,
  toggleWeekday,
} from './reminderDraft';
import type { ReminderDraft } from './reminderDraft';
import styles from './ReminderManagerPanel.module.css';

const SHAPES: Array<[ReminderShape, string]> = [
  ['circle', '●'],
  ['square', '■'],
  ['diamond', '◆'],
  ['triangle', '▲'],
  ['ring', '○'],
];

const MODES: Array<[ReminderMode, string]> = [
  ['log', '✓ tap-to-log'],
  ['countdown', 'countdown'],
  ['track', 'track'],
];

const TIME_OPTS: Array<[TimeOfDay, string]> = [
  ['morning', 'Morning'],
  ['afternoon', 'Midday'],
  ['evening', 'Evening'],
];

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      className={`${styles.chip} ${active ? styles.chipActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface ReminderManagerPanelProps {
  reminders: ReminderDef[];
  /** Commits the whole registry; resolves on success. */
  onSave: (rows: unknown[]) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * "Manage reminders" panel body — port of reminders.js
 * reminderManagerPanelHtml/_remDraftRowsHtml. Edits a working draft; "Save
 * changes" commits the whole registry at once.
 */
export function ReminderManagerPanel({ reminders, onSave, onCancel }: ReminderManagerPanelProps) {
  // Seeded once when the panel opens (re-seeds from fresh data on next open).
  const [drafts, setDrafts] = useState<ReminderDraft[]>(() => seedDrafts(reminders));

  function patch(i: number, p: Partial<ReminderDraft>) {
    setDrafts((cur) => cur.map((d, j) => (j === i ? { ...d, ...p } : d)));
  }

  async function save() {
    try {
      await onSave(coerceDraftsForSave(drafts));
      // parent closes the panel on success
    } catch {
      // error toast raised by the mutation (old code alert()ed)
    }
  }

  const actions = (
    <div className={styles.actions}>
      <button type="button" className={styles.cancelBtn} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className={styles.saveBtn} onClick={() => void save()}>
        Save changes
      </button>
    </div>
  );

  return (
    <div>
      <div className={styles.blurb}>
        These drive the calendar dots, the quick-log buttons above, and the pops on your To-Do page.{' '}
        <b>tap-to-log</b> pops when due · <b>countdown</b> always shows time left · <b>track</b> just logs (no pop).
      </div>

      {/* Save/Cancel mirrored top + bottom so she can click whichever's closer. */}
      <div className={styles.actionsTop}>{actions}</div>

      {drafts.length === 0 ? (
        <div className={styles.empty}>No reminders yet. Add one below.</div>
      ) : (
        drafts.map((r, i) => {
          const isTrack = r.mode === 'track';
          const schedule: ReminderSchedule = r.schedule || 'interval';
          const others = drafts.filter((_, j) => j !== i);
          return (
            <div key={i} className={styles.row}>
              <div className={styles.headRow}>
                <input
                  className={`${styles.input} ${styles.emojiInput}`}
                  value={r.emoji}
                  placeholder="🛏"
                  maxLength={4}
                  onChange={(e) => patch(i, { emoji: e.target.value })}
                />
                <input
                  className={`${styles.input} ${styles.labelInput}`}
                  value={r.label}
                  placeholder="What to track"
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
                <input
                  type="color"
                  className={styles.colorInput}
                  value={r.color || '#9AA0B5'}
                  title="Calendar color"
                  onChange={(e) => patch(i, { color: e.target.value })}
                />
                <button
                  type="button"
                  className={styles.delBtn}
                  title="Remove"
                  onClick={() => setDrafts((cur) => cur.filter((_, j) => j !== i))}
                >
                  &times;
                </button>
              </div>

              <div className={styles.chipRow}>
                {MODES.map(([mode, label]) => (
                  <Chip key={mode} active={r.mode === mode} onClick={() => patch(i, { mode })}>
                    {label}
                  </Chip>
                ))}
              </div>

              <div className={styles.optionRow}>
                <span title="Shape groups a family of rituals (meds, linens, body…); color names the individual">
                  calendar shape
                </span>
                <span className={styles.chipGroup}>
                  {SHAPES.map(([shape, glyph]) => (
                    <Chip key={shape} active={(r.shape || 'circle') === shape} onClick={() => patch(i, { shape })}>
                      {glyph}
                    </Chip>
                  ))}
                </span>
              </div>

              {!isTrack ? (
                <div className={styles.optionRow}>
                  {schedule === 'weekly' ? (
                    <span className={styles.weekdayGroup}>
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button
                          key={d}
                          type="button"
                          title={WEEKDAY_FULL[d]}
                          className={`${styles.weekdayBtn} ${r.weekdays.includes(d) ? styles.chipActive : ''}`}
                          onClick={() => patch(i, { weekdays: toggleWeekday(r.weekdays, d) })}
                        >
                          {WEEKDAY_LETTER[d]}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <>
                      <span>every</span>
                      <input
                        type="number"
                        min={1}
                        className={`${styles.input} ${styles.numInput}`}
                        value={r.every_days}
                        onChange={(e) =>
                          patch(i, { every_days: e.target.value === '' ? '' : Number(e.target.value) })
                        }
                      />
                      <span>d · overdue after</span>
                      <input
                        type="number"
                        min={1}
                        className={`${styles.input} ${styles.numInput}`}
                        value={r.overdue_days}
                        onChange={(e) =>
                          patch(i, { overdue_days: e.target.value === '' ? '' : Number(e.target.value) })
                        }
                      />
                      <span>d</span>
                    </>
                  )}
                  <span className={styles.schedChips}>
                    <Chip active={schedule !== 'weekly'} onClick={() => patch(i, { schedule: 'interval' })}>
                      every N days
                    </Chip>
                    <Chip active={schedule === 'weekly'} onClick={() => patch(i, { schedule: 'weekly' })}>
                      days of week
                    </Chip>
                  </span>
                </div>
              ) : null}

              {!isTrack ? (
                <div className={styles.optionRow}>
                  <span>when due, say</span>
                  <input
                    className={`${styles.input} ${styles.dueInput}`}
                    value={r.due_text}
                    placeholder="Due today"
                    maxLength={60}
                    onChange={(e) => patch(i, { due_text: e.target.value })}
                  />
                </div>
              ) : null}

              {!isTrack ? (
                <div className={styles.optionRow}>
                  <span>show on To-Do</span>
                  <span className={styles.chipGroup}>
                    {TIME_OPTS.map(([v, lbl]) => (
                      <Chip key={v} active={r.times.includes(v)} onClick={() => patch(i, { times: toggleTime(r.times, v) })}>
                        {lbl}
                      </Chip>
                    ))}
                  </span>
                  {!r.times.length ? <span className={styles.faint}>(all day)</span> : null}
                </div>
              ) : null}

              <div className={styles.optionRow}>
                <span>after logging, also ask about</span>
                <select
                  className={`${styles.input} ${styles.companionSelect}`}
                  value={r.companion}
                  onChange={(e) => patch(i, { companion: e.target.value })}
                >
                  <option value="">— none —</option>
                  {others.map((o) => (
                    <option key={o.type || o.label} value={o.type || ''}>
                      {(o.emoji ? `${o.emoji} ` : '') + (o.label || o.type || '')}
                    </option>
                  ))}
                </select>
              </div>

              <label className={styles.privacyRow}>
                <input
                  type="checkbox"
                  checked={r.private}
                  onChange={(e) => patch(i, { private: e.target.checked })}
                />
                private — hidden on the public calendar
              </label>
            </div>
          );
        })
      )}

      <button type="button" className={styles.addBtn} onClick={() => setDrafts((cur) => [...cur, newDraft()])}>
        + Add reminder
      </button>

      <div className={styles.actionsBottom}>{actions}</div>
    </div>
  );
}
