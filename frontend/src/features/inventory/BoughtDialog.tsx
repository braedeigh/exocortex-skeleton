/**
 * "Bought — where does it land?" dialog, shown when a non-consumable buy-list
 * row is marked bought. Consumables skip this and go straight to the active
 * loop (unchanged old behavior); durables/services/unsorted choose between:
 * - the Durables catalog (archivals) — opens the archival modal prefilled
 *   with the purchase record (date, cost, source, research notes) and a
 *   take-a-photo-on-arrival reminder; the order screenshot attaches there,
 * - the consumables restock loop,
 * - or just coming off the list.
 */
import { Modal } from './Modal';
import type { BuyItem } from './types';
import modalStyles from './Modal.module.css';
import styles from './inventory.module.css';

export interface BoughtDialogProps {
  item: BuyItem | null;
  onClose: () => void;
  /** Archivals catalog — opens the prefilled archival modal. */
  onToCatalog: (item: BuyItem) => void;
  /** Active-inventory consumables loop (the old move-to-active). */
  onToConsumables: (item: BuyItem) => void;
  /** Off the list, recorded nowhere (services, one-offs). */
  onJustRemove: (item: BuyItem) => void;
}

export function BoughtDialog({ item, onClose, onToCatalog, onToConsumables, onJustRemove }: BoughtDialogProps) {
  const pick = (fn: (i: BuyItem) => void) => () => {
    if (!item) return;
    onClose();
    fn(item);
  };
  return (
    <Modal open={item !== null} onClose={onClose} aria-label="Bought — where does it land?">
      {item ? (
        <>
          <p className={modalStyles.confirmText}>
            Bought <b>{item.name}</b> 🎉 — where does it land?
          </p>
          <div className={styles.boughtChoices}>
            <button type="button" className={styles.boughtChoiceBtn} onClick={pick(onToCatalog)}>
              📦 Durables catalog
              <span className={styles.boughtChoiceHint}>
                purchase record + order screenshot, photo reminder for arrival
              </span>
            </button>
            <button type="button" className={styles.boughtChoiceBtn} onClick={pick(onToConsumables)}>
              🔄 Consumables loop
              <span className={styles.boughtChoiceHint}>tracked in active inventory, restockable</span>
            </button>
            <button type="button" className={styles.boughtChoiceBtn} onClick={pick(onJustRemove)}>
              ✓ Just take it off the list
              <span className={styles.boughtChoiceHint}>no record kept (services, one-offs)</span>
            </button>
            <button type="button" className={styles.ghostBtn} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
