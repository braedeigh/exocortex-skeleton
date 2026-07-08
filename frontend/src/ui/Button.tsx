import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  children: ReactNode;
}

/** Touch-first button — min-height 44px, comfortable padding, enforced in CSS. */
export function Button({
  variant = 'primary',
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], fullWidth ? styles.fullWidth : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
