import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../ui';
import { FileCodeBody } from './FileCodeBody';
import styles from './FileCodeWindow.module.css';

/**
 * FileCodeWindow — tap a file on the map and read it: an opaque page that
 * takes the whole screen, with the file's name and path across the top and
 * one × (or Esc) that puts the map back exactly as it was.
 *
 * It used to be a frosted pane floating over a blurred map, sized so the
 * terrain showed around its edges. That's gone: the map is covered while a
 * file is open. The page is opaque on purpose — code over a field of moving
 * dots was the legibility cost the frost kept paying, and she asked for the
 * cover outright.
 *
 * One scroller: the page body is the only vertical scroll region and the
 * code flows into it (FileCodeBody's `uncapCode`); the code block keeps its
 * own HORIZONTAL scroll for long lines, which is the one thing it can't
 * inherit.
 *
 * Opening it never touches the canvas element, the d3-force sim, or the zoom
 * transform — it's portalled onto document.body, so the map underneath isn't
 * re-laid-out or re-simulated, only covered. Close and you're exactly where
 * you left off.
 *
 * The body is shared with the /code page (FileCodeBody); this file is the
 * frame. `children` is what the map knows that the file itself doesn't —
 * which agents touched it, and the footprint control for each.
 *
 * Prompt that produced it: "when I click on the code, it just pulls it up
 * over the entire terrain screen with an opaque background and I can click
 * an x to close it and go back."
 */
export function FileCodeWindow({
  repo,
  path,
  onClose,
  children,
}: {
  repo: string | null;
  path: string | null;
  onClose: () => void;
  /** What touched this file — rendered under the code, inside the same scroll. */
  children?: ReactNode;
}) {
  const open = repo !== null && path !== null;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // The tail of the path is the title — a deep path would ellipsize the actual
  // filename away — and the full path gets its own line under it.
  const name = path.split('/').filter(Boolean).slice(-1)[0] ?? path;

  return createPortal(
    <div className={styles.catcher} onClick={onClose} role="presentation">
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.name}>{name}</h2>
            {/* &lrm; keeps the RTL truncation from dragging leading
                punctuation to the wrong end of the visible tail. */}
            <div className={styles.path}>&lrm;{path}</div>
          </div>
          <IconButton aria-label="Close" onClick={onClose}>
            &times;
          </IconButton>
        </div>
        <div className={styles.body}>
          <FileCodeBody repo={repo} path={path} uncapCode />
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
