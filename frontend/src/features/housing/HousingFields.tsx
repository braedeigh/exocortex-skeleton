import { STATUS_OPTIONS, normalizeStatus } from './statusLadder';
import type { PlaceFields } from './types';
import styles from './HousingFields.module.css';

export interface HousingFieldsProps {
  value: PlaceFields;
  onChange: (patch: Partial<PlaceFields>) => void;
}

/**
 * Shared field block for both the add form and inline edit — port of
 * _housingFields() in static/js/housing.js (same fields, placeholders and
 * two-column grid), as a controlled component.
 */
export function HousingFields({ value, onChange }: HousingFieldsProps) {
  return (
    <div>
      <label className={styles.field}>
        Place name
        <input
          type="text"
          className={styles.input}
          value={value.name}
          placeholder="e.g. Peterson / Shoal Creek"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <label className={styles.field}>
        Link (optional)
        <input
          type="url"
          className={styles.input}
          value={value.link}
          placeholder="https://&hellip;"
          onChange={(e) => onChange({ link: e.target.value })}
        />
      </label>
      <div className={styles.grid}>
        <label className={styles.field}>
          Rent
          <input
            type="text"
            className={styles.input}
            value={value.rent}
            placeholder="$1000"
            onChange={(e) => onChange({ rent: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          Size
          <input
            type="text"
            className={styles.input}
            value={value.size}
            placeholder="1bd, 500sqft"
            onChange={(e) => onChange({ size: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          Area
          <input
            type="text"
            className={styles.input}
            value={value.area}
            placeholder="Rosedale"
            onChange={(e) => onChange({ area: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          Available
          <input
            type="text"
            className={styles.input}
            value={value.avail}
            placeholder="Jun 30 / late July"
            onChange={(e) => onChange({ avail: e.target.value })}
          />
        </label>
      </div>
      <label className={styles.field}>
        Status
        <select
          className={styles.input}
          value={normalizeStatus(value.status)}
          onChange={(e) => onChange({ status: e.target.value })}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className={`${styles.field} ${styles.last}`}>
        Notes
        <textarea
          className={`${styles.input} ${styles.textarea}`}
          rows={3}
          value={value.notes}
          placeholder="Gut read, flags, fit&hellip;"
          onChange={(e) => onChange({ notes: e.target.value })}
        />
      </label>
    </div>
  );
}
