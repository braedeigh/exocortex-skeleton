import { Sheet } from '../../ui';
import { FileCodeBody } from './FileCodeBody';

/**
 * FileCodeModal — tap a file on the map, read what's actually in it, close,
 * and the map is exactly where you left it.
 *
 * The "snaps back" part is structural, not animated: this is a portalled
 * overlay (ui/Sheet), so opening it never touches the canvas element, the
 * d3-force sim, or the zoom transform. The map underneath is not re-laid
 * out, re-fitted, or re-simulated — it's simply covered and then uncovered.
 *
 * Everything inside the sheet is FileCodeBody, shared with the /code page the
 * Observatory's session cards open into — this file is only the frame.
 */

export interface FileCodeModalProps {
  repo: string | null;
  path: string | null;
  onClose: () => void;
}

export function FileCodeModal({ repo, path, onClose }: FileCodeModalProps) {
  const open = repo !== null && path !== null;
  // The tail of the path is the title; the full path sits under it (inside the
  // body), since a deep path would ellipsize the actual filename out of the
  // header.
  const name = path ? (path.split('/').filter(Boolean).slice(-1)[0] ?? path) : '';

  return (
    <Sheet open={open} title={name} onClose={onClose} wide>
      <FileCodeBody repo={repo} path={path} />
    </Sheet>
  );
}
