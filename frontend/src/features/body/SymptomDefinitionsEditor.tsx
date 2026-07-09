import { useState } from 'react';
import { DEFINITION_FIELDS, cleanDefinitions } from './dotGridHelpers';
import type { SymptomDefinitions } from './types';
import styles from './SymptomDefinitionsEditor.module.css';

export interface SymptomDefinitionsEditorProps {
  definitions: SymptomDefinitions | undefined;
  onSave: (definitions: SymptomDefinitions) => void;
}

const LEVELS = ['0', '1', '2', '3'] as const;

function seedDraft(defs: SymptomDefinitions | undefined): SymptomDefinitions {
  const out: SymptomDefinitions = {};
  for (const f of DEFINITION_FIELDS) {
    out[f.key] = { ...(defs?.[f.key] || {}) };
  }
  return out;
}

/**
 * "Symptom definitions (what 0–3 mean)" editor — port of health.js
 * renderSymptomDefinitions/saveSymptomDefinitions. Lives inside a nested
 * <details> under the Symptom Tracker card. Drafts locally (so the 5s poll
 * can't wipe typing) and saves only non-empty rows.
 */
export function SymptomDefinitionsEditor({ definitions, onSave }: SymptomDefinitionsEditorProps) {
  const [draft, setDraft] = useState<SymptomDefinitions>(() => seedDraft(definitions));

  function setCell(col: string, level: string, text: string) {
    setDraft((cur) => ({ ...cur, [col]: { ...cur[col], [level]: text } }));
  }

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Symptom definitions (what 0&ndash;3 mean)</summary>
      <div className={styles.body}>
        <div className={styles.intro}>
          What each 0&ndash;3 means for you. Saved and shown as tooltips on the symptom buttons.
        </div>
        <div className={styles.fields}>
          {DEFINITION_FIELDS.map((f) => (
            <div key={f.key}>
              <div className={styles.fieldLabel}>{f.label}</div>
              <div className={styles.levels}>
                {LEVELS.map((level) => (
                  <div className={styles.levelRow} key={level}>
                    <span className={styles.levelNum}>{level}</span>
                    <input
                      type="text"
                      className={styles.levelInput}
                      value={draft[f.key]?.[level] || ''}
                      placeholder={f.hints[Number(level)]}
                      onChange={(e) => setCell(f.key, level, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button type="button" className={styles.saveBtn} onClick={() => onSave(cleanDefinitions(draft))}>
          Save definitions
        </button>
      </div>
    </details>
  );
}
