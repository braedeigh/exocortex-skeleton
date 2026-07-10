import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui';
import { SYMPTOM_FIELDS, SYMPTOM_LEVELS, symptomTip, symptomsLoggedOn } from './symptomHelpers';
import { useSymptomDefinitions } from './useTodayData';
import type { SymptomLevels } from '../../api/endpoints';
import type { HealthDay } from './types';
import styles from './SymptomCard.module.css';

export interface SymptomCardProps {
  healthData: HealthDay[] | undefined;
  serverDate: string;
  onLog: (date: string, symptoms: SymptomLevels) => void;
}

const KEY_DOTS: Array<{ level: number; color: string; label: string }> = [
  { level: 0, color: 'var(--green)', label: '0 None' },
  { level: 1, color: 'var(--yellow)', label: '1 Mild' },
  { level: 2, color: 'var(--orange)', label: '2 Moderate' },
  { level: 3, color: 'var(--red)', label: '3 Bad' },
];

/**
 * Morning symptom check-in — port of renderSymptomForm (health.js). Shows the
 * "Log today's symptoms" form until today has a logged energy value, then
 * disappears (the daily prompt pattern: gone once answered). The legacy
 * "Symptoms logged ✓ (edit)" re-expand only existed under the page-wide
 * "Show hidden prompts" toggle, which isn't ported yet — see the TODO in
 * TodosPage; editing a logged day lives on the Body tab meanwhile.
 */
export function SymptomCard({ healthData, serverDate, onLog }: SymptomCardProps) {
  const { data: definitions } = useSymptomDefinitions();
  const [date, setDate] = useState('');
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [noseSpray, setNoseSpray] = useState(false);

  if (symptomsLoggedOn(healthData, serverDate)) return null;

  function submit() {
    const symptoms: SymptomLevels = {};
    for (const f of SYMPTOM_FIELDS) symptoms[f.key] = levels[f.key] ?? 0;
    symptoms.nose_spray = noseSpray ? 1 : 0;
    onLog(date || serverDate, symptoms);
    setLevels({});
    setNoseSpray(false);
    setDate('');
  }

  return (
    <div className={styles.card}>
      <h3 className={styles.heading}>Log today&rsquo;s symptoms</h3>

      <label className={styles.dateField}>
        <span className={styles.dateLabel}>Date</span>
        <input
          className={styles.dateInput}
          type="date"
          value={date || serverDate}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>

      <div className={styles.key}>
        {KEY_DOTS.map((k) => (
          <span key={k.level} className={styles.keyItem}>
            <span className={styles.keyDot} style={{ background: k.color }} />
            {k.label}
          </span>
        ))}
      </div>
      <div className={styles.keyEnergy}>Energy: 0 Crashed &middot; 1 Low &middot; 2 Okay &middot; 3 Great</div>

      <div className={styles.grid}>
        {SYMPTOM_FIELDS.map((f) => (
          <div key={f.key} className={styles.field}>
            <span className={styles.fieldLabel}>{f.label}</span>
            <div className={styles.btnGroup}>
              {SYMPTOM_LEVELS.map((v) => (
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
          className={styles.sprayBox}
          type="checkbox"
          checked={noseSpray}
          onChange={(e) => setNoseSpray(e.target.checked)}
        />
        Nose spray used?
      </label>

      <Button variant="primary" onClick={submit}>
        Log
      </Button>
      <div>
        <Link className={styles.trackerLink} to="/body">
          View full symptom tracker &#8599;
        </Link>
      </div>
    </div>
  );
}
