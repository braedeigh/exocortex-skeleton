import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import styles from './TapRow.module.css';

interface TapRowBaseProps {
  trailing?: ReactNode;
  children: ReactNode;
}

export type TapRowProps = TapRowBaseProps &
  (
    | ({ as?: 'button' } & ButtonHTMLAttributes<HTMLButtonElement>)
    | ({ as: 'div' } & HTMLAttributes<HTMLDivElement>)
  );

/**
 * Touch-first list row — min-height 44px, full-width tap target.
 * Renders as a <button> by default (tappable row); pass as="div" for a
 * static row that just hosts its own inner controls.
 */
export function TapRow({ as = 'button', trailing, children, className, ...rest }: TapRowProps) {
  const classes = [styles.row, className].filter(Boolean).join(' ');

  if (as === 'div') {
    return (
      <div className={classes} {...(rest as HTMLAttributes<HTMLDivElement>)}>
        <div className={styles.content}>{children}</div>
        {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      <span className={styles.content}>{children}</span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </button>
  );
}
