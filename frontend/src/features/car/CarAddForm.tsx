import { useState } from 'react';
import type { AddCarEntryPayload } from './api';
import styles from './CarAddForm.module.css';

/**
 * "Log maintenance" card — port of renderCarAddForm/carToggleCustomType/
 * carSubmitAdd in static/js/car.js. Same fields, same custom-type reveal
 * ("Other…" shows a free-text input, blank custom falls back to "other"),
 * date defaults to the server's today. Submitting hands the raw string
 * payload up (optimistic add) and resets the form to defaults.
 */

const CUSTOM = '__custom__';

interface CarAddFormProps {
  /** Server's YYYY-MM-DD — the old form seeded the date input with _serverDate. */
  today: string;
  onAdd: (payload: AddCarEntryPayload) => void;
}

export function CarAddForm({ today, onAdd }: CarAddFormProps) {
  const [typeSel, setTypeSel] = useState('oil_change');
  const [custom, setCustom] = useState('');
  const [date, setDate] = useState(today);
  const [mileage, setMileage] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [notes, setNotes] = useState('');

  function submit() {
    const type = typeSel === CUSTOM ? custom.trim() || 'other' : typeSel;
    onAdd({ type, date, mileage, notes, next_due: nextDue });
    setTypeSel('oil_change');
    setCustom('');
    setDate(today);
    setMileage('');
    setNextDue('');
    setNotes('');
  }

  return (
    <div className={styles.card}>
      <div className={styles.title}>Log maintenance</div>

      <div className={styles.grid}>
        <label className={styles.field}>
          Type
          <select className={styles.input} value={typeSel} onChange={(e) => setTypeSel(e.target.value)}>
            <option value="oil_change">Oil change</option>
            <option value="brake_pads">Brake pads</option>
            <option value="registration">Registration</option>
            <option value={CUSTOM}>Other…</option>
          </select>
        </label>
        <label className={styles.field}>
          Date
          <input className={styles.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      {typeSel === CUSTOM ? (
        <div className={styles.customWrap}>
          <label className={styles.field}>
            Custom type
            <input
              className={styles.input}
              type="text"
              placeholder="e.g. tire_rotation"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      <div className={styles.grid}>
        <label className={styles.field}>
          Mileage (optional)
          <input
            className={styles.input}
            type="number"
            placeholder="e.g. 87500"
            value={mileage}
            onChange={(e) => setMileage(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Next due (optional)
          <input className={styles.input} type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
        </label>
      </div>

      <label className={`${styles.field} ${styles.notesField}`}>
        Notes (optional)
        <textarea className={styles.textarea} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <button type="button" className={styles.submit} onClick={submit}>
        Add entry
      </button>
    </div>
  );
}
