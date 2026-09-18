import { useEffect, type ReactNode } from 'react';
import { IconButton } from '../../ui';
import { FileCodeBody } from './FileCodeBody';
import type { ThemeInk } from './terrainCanvas';
import styles from './FileCodeWindow.module.css';

/**
 * FileCodeWindow — tap a file on the map and read it: an opaque pane INSIDE
 * the terrain page, with the file's name and path across the top and one ×
 * (or Esc) that puts the map back exactly as it was.
 *
 * This file is the frame. The contents are FileCodeBody, shared with the
 * /code page; TerrainPage.tsx opens the pane and hands it what the map knows.
 *
 * Where it sits: over the whole terrain panel it was opened from, and only
 * that panel (FileCodeWindow.module.css .pane). On a single screen that is
 * the full page; when the screen is split in two or three it is the
 * terrain's own tile. It never reaches over a neighbouring panel, and the
 * map is hidden behind it until × — to read a different file, close and tap
 * another dot.
 *
 * Opening it never touches the d3-force sim, the zoom transform, or the
 * canvas's size, so closing it drops you back onto exactly the map you left.
 *
 * Her ask: "it should only cover the window it's open on. like if the screen
 * is split into 2 or 3, it should cover only in the one i'm opening it into."
 */
export function FileCodeWindow({
  repo,
  path,
  onClose,
  children,
  windowSeconds,
  runWindowSeconds,
  ink,
}: {
  repo: string | null;
  path: string | null;
  onClose: () => void;
  /** What the map knows that the file itself doesn't — which agents touched
   * it, and the footprint control for each. Rendered under the code, inside
   * the same scroll. */
  children?: ReactNode;
  /** The map's live heat window (breath included), handed straight through
   * to the body so its red-edits toggle paints lines on the same lens the
   * dots outside the pane are wearing. */
  windowSeconds?: number;
  /** The map's live gold window, handed straight through to the body the
   * same way, for its gold-ran toggle. */
  runWindowSeconds?: number;
  /** The map's theme ink, handed straight through to the body, for the same
   * ember ramp the dots use. */
  ink?: ThemeInk;
}) {
  const open = repo !== null && path !== null;

  // Close on Esc. The key listener is only attached while the pane is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Take the filename off the end of the path, for the title. A deep path
  // would ellipsize the actual filename away, so the name gets the title
  // line and the full path gets its own line under it.
  const name = path.split('/').filter(Boolean).slice(-1)[0] ?? path;

  return (
    <div className={styles.pane} role="dialog" aria-label={name}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <h2 className={styles.name}>{name}</h2>
          {/* Keep the path's punctuation where it belongs. The path line is
              set right-to-left so it truncates from the LEFT
              (FileCodeWindow.module.css .path); &lrm; keeps that from
              dragging leading punctuation to the wrong end of the visible
              tail. */}
          <div className={styles.path}>&lrm;{path}</div>
        </div>
        <IconButton aria-label="Close" onClick={onClose}>
          &times;
        </IconButton>
      </div>
      {/* The pane's one scroll region: the code, then what touched the file.
          The pane body is the only vertical scroller and the code flows into
          it at full height (FileCodeBody's `uncapCode`); the code block keeps
          its own HORIZONTAL scroll for long lines, which is the one thing it
          can't inherit. */}
      <div className={styles.body}>
        <FileCodeBody repo={repo} path={path} uncapCode windowSeconds={windowSeconds} runWindowSeconds={runWindowSeconds} ink={ink ?? undefined} />
        {children}
      </div>
    </div>
  );
}
