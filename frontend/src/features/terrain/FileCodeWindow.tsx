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
 * Where it sits follows the map's own width, not the window's
 * (FileCodeWindow.module.css, measured against TerrainPage's container):
 *
 * - Wide map (most of the window): the pane takes the map's RIGHT half, edge
 *   to edge, and the map keeps the left half with its chrome pulled in to
 *   match (TerrainPage.module.css .pageFileOpen). The map stays live: tap
 *   another dot and the pane shows that file instead.
 * - Narrow map (a phone, or the terrain already one side of the desktop
 *   split): the pane covers the map's whole area — the terrain's side of the
 *   split and nothing else. It never reaches over other panels.
 *
 * Opening it never touches the d3-force sim or the zoom transform. On a wide
 * map the canvas does get narrower (the page shrinks it to the left half),
 * but a resize only redraws at the new size under the same transform — the
 * left half of the map is exactly where it was, and closing gives the right
 * half back unmoved.
 *
 * Her ask: "when i open a file it doesn't show up on the whole screen, it
 * just shows up on the right side of the screen like the split screen on the
 * terrain side".
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
