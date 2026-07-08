import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children?: ReactNode;
}

/**
 * Touch-first checkbox — the clickable label spans a 44px-tall row even
 * though the visible box is compact, per the "small until edit" pattern.
 */
export function Checkbox({ children, className, ...rest }: CheckboxProps) {
  return (
    <label className={[styles.label, className].filter(Boolean).join(' ')}>
      <input type="checkbox" className={styles.input} {...rest} />
      <span className={styles.box}>
        <svg className={styles.check} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 8.5L6.5 12L13 4.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {children ? <span className={styles.text}>{children}</span> : null}
    </label>
  );
}
