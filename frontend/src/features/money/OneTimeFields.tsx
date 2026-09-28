/**
 * OneTimeFields.tsx — the "One-time thing" control on the Money page. A chip
 * marks an expense as a one-time purchase (a mattress, toilet cleaner) instead
 * of everyday spending in its category. Once it's on, two more fields appear:
 * what she bought, and which Inventory shelf it goes on ("Keep it" goes to
 * Durables, "Used up" goes to Consumables), with the shelf named beside the
 * switch.
 *
 * Two pieces, both controlled (the parent holds the value), so a row can put
 * the chip in its line and the detail underneath. Used by the statement preview
 * (CsvImportSection.tsx, filed on import) and Recent expenses
 * (RecentExpensesSection.tsx, filed when she taps Put in Inventory). The filing
 * itself is routes/inventory.py file_purchase.
 * Prompt: "i want it as a 'thing' so i can know it was a 'one time purchase'"
 * / "i want it to also add something to my inventory".
 */
import type { InventoryShelf, OneTimeThing } from './types';
import styles from './money.module.css';

export interface OneTimeFieldsProps {
  value: OneTimeThing | null;
  onChange: (value: OneTimeThing | null) => void;
  /** Shown faint in the "what was it?" box, e.g. the expense's name. */
  namePlaceholder?: string;
}

const SHELVES: { shelf: InventoryShelf; label: string; destination: string }[] = [
  { shelf: 'durables', label: 'Keep it', destination: 'Durables' },
  { shelf: 'consumables', label: 'Used up', destination: 'Consumables' },
];

/** The chip on its own: one tap marks it, another unmarks it. */
export function OneTimeChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={on ? `${styles.oneTimeChip} ${styles.oneTimeChipOn}` : styles.oneTimeChip}
      aria-pressed={on}
      onClick={onToggle}
    >
      {on ? '✓ One-time' : 'One-time?'}
    </button>
  );
}

/** What was bought and which shelf it goes on: shown once the chip is on.
 * A fresh mark starts on Durables with the name blank, so the placeholder
 * shows the expense's own name, which is what a blank name falls back to. */
export function OneTimeDetail({ value, onChange, namePlaceholder }: OneTimeFieldsProps & { value: OneTimeThing }) {
  const destination = SHELVES.find((s) => s.shelf === value.shelf)?.destination ?? 'Durables';
  return (
    <div className={styles.oneTimeDetail}>
      <div className={styles.oneTimeLine}>
        <input
          type="text"
          className={styles.stmtName}
          value={value.name}
          placeholder={namePlaceholder ? `What was it? (${namePlaceholder})` : 'What was it?'}
          aria-label="What did you buy?"
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
        <div className={styles.shelfWrap}>
          <div className={styles.shelfToggle} role="radiogroup" aria-label="Inventory shelf">
            {SHELVES.map((s) => (
              <button
                key={s.shelf}
                type="button"
                role="radio"
                aria-checked={value.shelf === s.shelf}
                className={value.shelf === s.shelf ? `${styles.shelfBtn} ${styles.shelfBtnOn}` : styles.shelfBtn}
                onClick={() => onChange({ ...value, shelf: s.shelf })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className={styles.oneTimeHint}>→ Inventory · {destination}</span>
        </div>
      </div>
    </div>
  );
}
