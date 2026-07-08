import { IconButton } from '../../ui';
import styles from './FindBar.module.css';

export interface FindBarProps {
  name: string;
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/** "n of N" — lands on the first mention of a name after jumping to a referenced day. */
export function FindBar({ name, current, total, onPrev, onNext, onClose }: FindBarProps) {
  return (
    <div className={styles.bar}>
      <span className={styles.name}>{name}</span>
      <span className={styles.count}>
        {current} of {total}
      </span>
      <IconButton aria-label="Previous mention" onClick={onPrev}>
        &uarr;
      </IconButton>
      <IconButton aria-label="Next mention" onClick={onNext}>
        &darr;
      </IconButton>
      <IconButton aria-label="Close find" onClick={onClose}>
        &times;
      </IconButton>
    </div>
  );
}
