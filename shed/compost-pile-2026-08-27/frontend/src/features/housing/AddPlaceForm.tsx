import { useState } from 'react';
import { HousingFields } from './HousingFields';
import { EMPTY_FIELDS } from './types';
import type { PlaceFields } from './types';
import styles from './AddPlaceForm.module.css';

export interface AddPlaceFormProps {
  onAdd: (fields: PlaceFields) => void;
}

/**
 * "＋ Add a place" — port of renderHousingAddForm(): a <details> that stays
 * collapsed until tapped. Submitting adds optimistically, then clears the
 * fields and collapses again (the old page got that for free from the
 * full re-render after loadDashboard()).
 */
export function AddPlaceForm({ onAdd }: AddPlaceFormProps) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<PlaceFields>(EMPTY_FIELDS);

  function submit() {
    onAdd(fields);
    setFields(EMPTY_FIELDS);
    setOpen(false);
  }

  return (
    <details
      className={styles.details}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.summary}>
        <span className={styles.plus}>＋</span> Add a place
      </summary>
      <div className={styles.body}>
        <HousingFields value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} />
        <button type="button" className={styles.addBtn} onClick={submit}>
          Add place
        </button>
      </div>
    </details>
  );
}
