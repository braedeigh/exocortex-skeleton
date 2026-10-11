import { useEffect, useRef, useState } from 'react';
import { DAY_EDITOR_FIELDS, buildDaySymptomsPayload, symptomTip } from './dotGridHelpers';
import { editorDayLabel, splitFoodNotes } from './foodLogHelpers';
import type { BodyHealthDay, SymptomDefinitions } from './types';
import styles from './DayEditor.module.css';

export interface DayEditorProps {
  day: BodyHealthDay;
  definitions: SymptomDefinitions | undefined;
  onClose: () => void;
  onSave: (date: string, symptoms: Record<string, number>, foodNotes: string) => void;
}

const LEVELS = [0, 1, 2, 3] as const;

function seedLevels(day: BodyHealthDay): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of DAY_EDITOR_FIELDS) {
    const v = day[f.key];
    out[f.key] = v === null || v === undefined ? null : (v as number);
  }
  return out;
}

/**
 * Per-day symptom + food editor — port of overview.js openDayEditor/
 * saveDayEditor. This is the ONE place an already-logged day can be edited.
 * Selections are seeded from the day's existing values so unchanged fields
 * persist on save; never-logged fields stay out of the payload entirely.
 */
export function DayEditor({ day, definitions, onClose, onSave }: DayEditorProps) {
  const [levels, setLevels] = useState<Record<string, number | null>>(() => seedLevels(day));
  const [noseSpray, setNoseSpray] = useState(day.nose_spray === true);
  const [food, setFood] = useState(splitFoodNotes(day.food_notes).join('; '));
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-seed when the editor is retargeted at a different day.
  const dateRef = useRef(day.date);
  useEffect(() => {
    if (dateRef.current === day.date) return;
    dateRef.current = day.date;
    setLevels(seedLevels(day));
    setNoseSpray(day.nose_spray === true);
    setFood(splitFoodNotes(day.food_notes).join('; '));
  }, [day]);

  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [day.date]);

  const label = editorDayLabel(day.date);

  function save() {
    onSave(day.date, buildDaySymptomsPayload(levels, noseSpray), food);
  }

  return (
    <div className={styles.editor} ref={rootRef}>
      <div className={styles.head}>
        <h3 className={styles.heading}>Edit {label}</h3>
        <button type="button" className={styles.closeBtn} title="Close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className={styles.key}>
        <span className={styles.keyItem}>
          <span className={styles.keyDot} style={{ background: 'var(--green)' }} /> 0 None
        </span>
        <span className={styles.keyItem}>
          <span className={styles.keyDot} style={{ background: 'var(--yellow)' }} /> 1 Mild
        </span>
        <span className={styles.keyItem}>
          <span className={styles.keyDot} style={{ background: 'var(--orange)' }} /> 2 Moderate
        </span>
        <span className={styles.keyItem}>
          <span className={styles.keyDot} style={{ background: 'var(--red)' }} /> 3 Bad
        </span>
      </div>
      <div className={styles.keyEnergy}>Energy: 0 Crashed &middot; 1 Low &middot; 2 Okay &middot; 3 Great</div>

      <div className={styles.grid}>
        {DAY_EDITOR_FIELDS.map((f) => (
          <div key={f.key} className={styles.field}>
            <span className={styles.fieldLabel}>{f.label}</span>
            <div className={styles.btnGroup}>
              {LEVELS.map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`${styles.symBtn} ${levels[f.key] === v ? styles.selected : ''}`}
                  data-col={f.key === 'energy' ? 'energy' : 'symptom'}
                  data-val={v}
                  title={symptomTip(definitions, f.key, v)}
                  onClick={() => setLevels((cur) => ({ ...cur, [f.key]: v }))}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <label className={styles.spray}>
        <input
          type="checkbox"
          className={styles.sprayBox}
          checked={noseSpray}
          onChange={(e) => setNoseSpray(e.target.checked)}
        />
        Nose spray used?
      </label>

      <label className={styles.foodField}>
        <span className={styles.foodLabel}>Food this day</span>
        <textarea
          className={styles.foodInput}
          placeholder="Foods, separated by ; "
          value={food}
          onChange={(e) => setFood(e.target.value)}
        />
      </label>

      <button type="button" className={styles.saveBtn} onClick={save}>
        Save {label}
      </button>
    </div>
  );
}
