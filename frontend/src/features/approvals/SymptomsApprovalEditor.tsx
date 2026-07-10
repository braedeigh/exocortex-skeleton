/**
 * SymptomsApprovalEditor — approval editor for kind "symptoms" (port of
 * static/js/approvals/long-covid.js). Mirrors the native symptom form: six
 * 0–3 button groups (only fields with a selection are committed), histamine
 * flare yes/no, and a flare-trigger input, committing through the native
 * POST /api/symptoms. Undo re-POSTs the prior row's values when one existed;
 * with no prior row it reopens this editor (no DELETE endpoint exists).
 */
import { useRef, useState } from 'react';
import { Button } from '../../ui';
import { postSymptoms } from './api';
import { useTodaySnapshot } from './hooks';
import { findHealthRow, payloadRecord, todayISO } from './shared';
import {
  SYMPTOM_FIELDS,
  SYMPTOM_LEVELS,
  buildSymptomsLog,
  symptomsDraftFromPayload,
  symptomsUndoValues,
} from './symptomsApproval';
import type { SymptomsDraft } from './symptomsApproval';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

const KEY_DOTS = [
  { color: 'var(--green)', label: '0 None' },
  { color: 'var(--yellow)', label: '1 Mild' },
  { color: 'var(--orange)', label: '2 Moderate' },
  { color: 'var(--red)', label: '3 Bad' },
];

export function SymptomsApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const snapshot = useTodaySnapshot();
  const [draft, setDraft] = useState<SymptomsDraft>(() =>
    symptomsDraftFromPayload(payloadRecord(change), todayISO()),
  );
  const [error, setError] = useState('');
  const dateRef = useRef<HTMLInputElement>(null);

  function submit() {
    const built = buildSymptomsLog(draft);
    if (!built.ok) {
      setError(built.error);
      dateRef.current?.focus();
      return;
    }
    const { date, symptoms } = built.value;
    // Snapshot the existing row now — before /api/symptoms overwrites it.
    const prevRow = findHealthRow(snapshot.data?.health_data, date);
    onApprove({
      final: { date, ...symptoms },
      toastMessage: `Logged symptoms for ${date}`,
      commit: async () => {
        await postSymptoms(date, symptoms);
        const old = symptomsUndoValues(prevRow);
        if (!old) return { reopen: true }; // best-effort undo: no prior row to restore
        return {
          run: async () => {
            await postSymptoms(date, old);
          },
        };
      },
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-sym-date">
          Date
        </label>
        <input
          id="ap-sym-date"
          ref={dateRef}
          className={styles.input}
          type="date"
          value={draft.date}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
      </div>

      <div className={styles.key}>
        {KEY_DOTS.map((k) => (
          <span key={k.label} className={styles.keyItem}>
            <span className={styles.keyDot} style={{ background: k.color }} />
            {k.label}
          </span>
        ))}
      </div>
      <div className={styles.keyEnergy}>Energy: 0 Crashed &middot; 1 Low &middot; 2 Okay &middot; 3 Great</div>

      <div className={styles.symGrid}>
        {SYMPTOM_FIELDS.map((f) => (
          <div key={f.key}>
            <span className={styles.symLabel}>{f.label}</span>
            <div className={styles.symGroup}>
              {SYMPTOM_LEVELS.map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`${styles.symBtn} ${draft.levels[f.key] === v ? styles.selected : ''}`}
                  data-col={f.key === 'energy' ? 'energy' : 'symptom'}
                  data-val={v}
                  onClick={() => setDraft((d) => ({ ...d, levels: { ...d.levels, [f.key]: v } }))}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Histamine flare</span>
        <div className={styles.symGroup}>
          {(['yes', 'no'] as const).map((v) => (
            <button
              type="button"
              key={v}
              className={`${styles.flareBtn} ${draft.flare === v ? styles.selected : ''}`}
              onClick={() => setDraft((d) => ({ ...d, flare: v }))}
            >
              {v === 'yes' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-sym-trigger">
          Flare trigger <span className={styles.optional}>(if any)</span>
        </label>
        <input
          id="ap-sym-trigger"
          className={styles.input}
          type="text"
          placeholder="e.g. onions, stress, heat"
          value={draft.trigger}
          onChange={(e) => setDraft((d) => ({ ...d, trigger: e.target.value }))}
        />
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <Button variant="secondary" type="button" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Approve
        </Button>
      </div>
    </form>
  );
}
