import { Sheet } from '../../ui';
import { useTerrainFile } from './api';
import styles from './FileCodeModal.module.css';

/**
 * FileCodeModal — tap a file on the map, read what's actually in it, close,
 * and the map is exactly where you left it.
 *
 * The "snaps back" part is structural, not animated: this is a portalled
 * overlay (ui/Sheet), so opening it never touches the canvas element, the
 * d3-force sim, or the zoom transform. The map underneath is not re-laid
 * out, re-fitted, or re-simulated — it's simply covered and then uncovered.
 *
 * The summary above the code is the file's OWN leading docblock, lifted
 * server-side (routes/reading_room.py `_terrain_file_summary`), not a
 * generated description. This codebase explains itself at the top of nearly
 * every file, so the honest answer to "what is this" was already written;
 * when a file doesn't say, the modal says nothing rather than guessing.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileCodeModalProps {
  repo: string | null;
  path: string | null;
  onClose: () => void;
}

export function FileCodeModal({ repo, path, onClose }: FileCodeModalProps) {
  const open = repo !== null && path !== null;
  const { data, isLoading, isError, error } = useTerrainFile(repo, path);

  // The tail of the path is the title; the full path sits under it, since a
  // deep path would ellipsize the actual filename out of the header.
  const name = path ? (path.split('/').filter(Boolean).slice(-1)[0] ?? path) : '';

  return (
    <Sheet open={open} title={name} onClose={onClose} wide>
      <div className={styles.body}>
        <div className={styles.path}>{path}</div>

        {isLoading ? <div className={styles.hint}>Reading the file…</div> : null}

        {isError ? (
          <div className={styles.hint}>
            Couldn&rsquo;t read this one
            {error instanceof Error && error.message ? ` — ${error.message.toLowerCase()}` : '.'}
          </div>
        ) : null}

        {data?.summary ? (
          <div className={styles.summary}>
            {data.summary.split('\n\n').map((para, i) => (
              <p key={i} className={styles.summaryPara}>
                {para}
              </p>
            ))}
          </div>
        ) : null}

        {data && !data.binary && data.summary === null ? (
          <div className={styles.hint}>This file doesn&rsquo;t describe itself.</div>
        ) : null}

        {data ? (
          <div className={styles.meta}>
            {formatBytes(data.size)}
            {!data.binary ? ` · ${data.lines.toLocaleString()} lines` : null}
            {data.truncated ? ' · showing the first part only' : null}
          </div>
        ) : null}

        {data?.binary ? (
          <div className={styles.hint}>Binary file — nothing to read here.</div>
        ) : null}

        {data?.content ? (
          <pre className={styles.code}>
            <code>{data.content}</code>
          </pre>
        ) : null}

        {data?.truncated ? (
          <div className={styles.hint}>
            Truncated at {formatBytes(data.content?.length ?? 0)} — open it in the editor for the rest.
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
