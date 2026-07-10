import styles from './ColorField.module.css';
import { hexWithAlphaFrom, normalizeHexForPicker } from './settingsHelpers';

export interface ColorFieldProps {
  label: string;
  /** The effective value — hex ('#1a1a2e') or rgba ('rgba(220,210,195,0.75)'). */
  value: string;
  onChange: (value: string) => void;
}

/**
 * A paired color-picker + free-text input, the settings.js color-row: the
 * picker shows the value's RGB (rgba values keep their alpha through picker
 * edits), the text field accepts anything and is the source of truth.
 */
export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const isRgba = value.startsWith('rgba');

  function onPick(hex: string) {
    onChange(isRgba ? hexWithAlphaFrom(hex, value) : hex);
  }

  return (
    <div className={styles.row}>
      <label className={styles.label}>
        <span className={styles.labelText}>{label}</span>
        <input
          type="color"
          className={styles.picker}
          value={normalizeHexForPicker(value)}
          onChange={(e) => onPick(e.target.value)}
          aria-label={`${label} color picker`}
        />
      </label>
      <input
        type="text"
        className={styles.text}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} color value`}
        spellCheck={false}
      />
    </div>
  );
}
