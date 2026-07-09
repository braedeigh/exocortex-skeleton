import { useState } from 'react';
import { habitSectionDefs } from '../habits/habitMath';
import { habitMeta } from '../habits/habitMath';
import { habitSectionsOf } from './habitGrid';
import { addDaysISO } from './calendarMath';
import type { MapData } from './types';
import styles from './HabitConfigPanel.module.css';

export interface HabitConfigTarget {
  /** null section+item = the "New habit" flow. */
  section: string | null;
  item: string | null;
}

export interface HabitConfigPanelProps {
  data: MapData;
  target: HabitConfigTarget;
  onSave: (payload: { name: string; sections: string[]; course_days: number }) => Promise<unknown>;
  onDelete: (name: string) => Promise<unknown>;
  onClose: () => void;
}

/**
 * Habit config panel ("New habit" / "Edit habit") — port of habits.js
 * _openHabitConfig/saveHabitConfig/hcDelete: name, time-of-day checkboxes,
 * optional temporary course with an end-date preview, delete on edit.
 */
export function HabitConfigPanel({ data, target, onSave, onDelete, onClose }: HabitConfigPanelProps) {
  const isEdit = !!target.item;
  const meta = target.item && target.section ? habitMeta(data.habit_meta, target.section, target.item) : null;
  const initialCourseDays = meta?.course_days || 0;

  const [name, setName] = useState(target.item || '');
  const [sections, setSections] = useState<string[]>(() =>
    target.item ? habitSectionsOf(data.habits, target.item) : [],
  );
  const [courseOn, setCourseOn] = useState(initialCourseDays > 0);
  const [courseDays, setCourseDays] = useState(String(initialCourseDays || 10));

  const defs = habitSectionDefs(data.habits);
  const days = parseInt(courseDays, 10);
  const endLabel =
    courseOn && days >= 1
      ? new Date(`${addDaysISO(data.server_date, days - 1)}T12:00:00`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : '';

  function toggleSection(sec: string, checked: boolean) {
    setSections((cur) => (checked ? [...cur, sec] : cur.filter((s) => s !== sec)));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      alert('Give it a name');
      return;
    }
    if (!sections.length) {
      alert('Pick at least one time of day');
      return;
    }
    try {
      await onSave({ name: trimmed, sections, course_days: courseOn ? days || 0 : 0 });
      onClose();
    } catch {
      // error toast already raised by the mutation
    }
  }

  async function del() {
    if (!target.item) return;
    if (!confirm(`Remove "${target.item}" from all habit sections? Its history stays.`)) return;
    try {
      await onDelete(target.item);
      onClose();
    } catch {
      // error toast already raised by the mutation
    }
  }

  return (
    <div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="hc-name">
          Name
        </label>
        <input
          id="hc-name"
          type="text"
          className={styles.input}
          style={isEdit ? { opacity: 0.7 } : undefined}
          value={name}
          placeholder="e.g. Doxycycline"
          readOnly={isEdit}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Time of day</span>
        <div className={styles.checks}>
          {defs.map((s) => (
            <label key={s.name} className={styles.checkLabel}>
              <input
                type="checkbox"
                className={styles.check}
                checked={sections.includes(s.name)}
                onChange={(e) => toggleSection(s.name, e.target.checked)}
              />{' '}
              {s.label}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            className={styles.check}
            checked={courseOn}
            onChange={(e) => setCourseOn(e.target.checked)}
          />
          <span className={styles.label} style={{ margin: 0 }}>
            Temporary course — auto-archives when it ends
          </span>
        </label>
        {courseOn ? (
          <div className={styles.courseFields}>
            <span>Length</span>
            <input
              type="number"
              min={1}
              className={styles.input}
              style={{ width: 72 }}
              value={courseDays}
              onChange={(e) => setCourseDays(e.target.value)}
            />
            <span>days</span>
            <span className={styles.courseEnd}>{endLabel ? `→ ends ${endLabel}` : ''}</span>
          </div>
        ) : null}
      </div>

      <div className={styles.foot}>
        {isEdit ? (
          <button type="button" className={styles.deleteBtn} onClick={() => void del()}>
            Delete
          </button>
        ) : (
          <span />
        )}
        <button type="button" className={styles.saveBtn} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
