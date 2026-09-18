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
 * It used to be portalled onto document.body and take the entire viewport,
 * which covered whatever sat beside the terrain too. Her ask: "when i open a
 * file it doesn't show up on the whole screen, it just shows up on the right
 * side of the screen like the split screen on the terrain side".
 *
 * One scroller: the pane body is the only vertical scroll region and the
 * code flows into it (FileCodeBody's `uncapCode`); the code block keeps its
 * own HORIZONTAL scroll for long lines, which is the one thing it can't
 * inherit.
 *
 * Opening it never touches the d3-force sim or the zoom transform. On a wide
 * map the canvas does get narrower (the page shrinks it to the left half),
 * but a resize only redraws at the new size under the same transform — the
 * left half of the map is exactly where it was, and closing gives the right
 * half back unmoved.
 *
 * The body is shared with the /code page (FileCodeBody); this file is the
 * frame. `children` is what the map knows that the file itself doesn't —
 * which agents touched it, and the footprint control for each.
 * `windowSeconds` and `ink` are the map's live heat window and theme ink,
 * handed straight through to the body so its red-edits toggle paints lines
 * on the very lens and ramp the dots outside the pane are wearing.
 */
export function FileCodeWindow({
  repo,
  path,
  onClose,
  children,
  windowSeconds,
  ink,
}: {
  repo: string | null;
  path: string | null;
  onClose: () => void;
  /** What touched this file — rendered under the code, inside the same scroll. */
  children?: ReactNode;
  /** The map's live heat window (breath included), for the red-edits lines. */
  windowSeconds?: number;
  /** The map's theme ink, for the same ember ramp the dots use. */
  ink?: ThemeInk;
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

  return (
    <div className={styles.pane} role="dialog" aria-label={name}>
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
        <FileCodeBody repo={repo} path={path} uncapCode windowSeconds={windowSeconds} ink={ink ?? undefined} />
        {children}
      </div>
    </div>
  );
}
