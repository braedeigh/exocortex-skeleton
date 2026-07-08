import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only controls must always have an accessible name. */
  'aria-label': string;
  danger?: boolean;
  children: ReactNode;
}

/**
 * Touch-first icon button — 44x44px hit area, used for delete/close/× actions.
 * `danger` gives it a visible tinted background so it never reads as faint.
 */
export function IconButton({ danger = false, className, children, ...rest }: IconButtonProps) {
  const classes = [styles.iconButton, danger ? styles.danger : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} {...rest}>
      <span className={styles.glyph}>{children}</span>
    </button>
  );
}
