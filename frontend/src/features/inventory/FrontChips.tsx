/**
 * Front tag chips for buy items — a multi-select toggle row over the shared
 * fronts vocabulary (features/fronts/useFronts). Used in the buy add form and
 * the buy edit modal/detail; reuses the archival filter-panel chip styles.
 */
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import styles from './inventory.module.css';

export interface FrontChipsProps {
  selected: string[];
  onToggle: (frontId: string) => void;
}

export function FrontChips({ selected, onToggle }: FrontChipsProps) {
  const { data: fronts } = useFronts();
  if (!fronts?.length) return null;
  return (
    <div className={styles.chipRow}>
      {fronts.map((f) => {
        const active = selected.includes(f.id);
        return (
          <button
            type="button"
            key={f.id}
            className={`${styles.chip} ${active ? styles.chipActive : ''}`}
            aria-pressed={active}
            onClick={() => onToggle(f.id)}
          >
            {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
          </button>
        );
      })}
    </div>
  );
}

/** Toggle helper — add/remove one front id from a selection. */
export function toggleFront(selected: string[], frontId: string): string[] {
  return selected.includes(frontId) ? selected.filter((f) => f !== frontId) : [...selected, frontId];
}
