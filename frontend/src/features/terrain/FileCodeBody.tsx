import { useTerrainFile } from './api';
import styles from './FileCodeBody.module.css';

/**
 * FileCodeBody — one file's actual contents, fetched from the terrain file
 * endpoint (GET /api/observatory/terrain/file) and laid out identically in
 * both places it's shown: the map's tap-a-node modal (FileCodeModal) and the
 * /code page a session card's file list opens into (FileCodePage). One fetch,
 * one layout, two frames around it.
 *
 * The summary above the code is the file's OWN leading docblock, lifted
 * server-side (routes/observatory.py `_terrain_file_summary`), not a generated
 * description. This codebase explains itself at the top of nearly every file,
 * so the honest answer to "what is this" was already written; when a file
 * doesn't say, this says nothing rather than guessing.
 *
 * `fill` is what separates the two frames, and it does two things:
 *
 *   - The code block grows to take the pane instead of being capped at 55vh
 *     (the modal caps it so a long file can't push the close button off top).
 *   - The summary card is DROPPED. On the page it was the same text twice —
 *     the docblock in the card, then the identical docblock at the top of the
 *     code right below it — and because that card won't shrink below its own
 *     content, a long one ate the whole pane and squeezed the code block to
 *     nothing, so the page clipped instead of scrolling. In the modal the
 *     summary still earns its keep: the point there is to read what a file IS
 *     without reading the file.
 */
export function FileCodeBody({
  repo,
  path,
  fill = false,
}: {
  repo: string | null;
  path: string | null;
  /** Page mode: let the code block grow instead of capping it at 55vh. */
  fill?: boolean;
}) {
  const { data, isLoading, isError, error } = useTerrainFile(repo, path);

  return (
    <div className={[styles.body, fill ? styles.bodyFill : ''].filter(Boolean).join(' ')}>
      {/* The modal's header is only the filename, so the full path goes here.
          The page has room to put it in its own header, next to the title —
          so in fill mode this line would just be saying it twice. */}
      {!fill ? <div className={styles.path}>{path}</div> : null}

      {isLoading ? <div className={styles.hint}>Reading the file…</div> : null}

      {isError ? (
        <div className={styles.hint}>
          Couldn&rsquo;t read this one
          {error instanceof Error && error.message ? ` — ${error.message.toLowerCase()}` : '.'}
        </div>
      ) : null}

      {!fill && data?.summary ? (
        <div className={styles.summary}>
          {data.summary.split('\n\n').map((para, i) => (
            <p key={i} className={styles.summaryPara}>
              {para}
            </p>
          ))}
        </div>
      ) : null}

      {/* Only meaningful next to the summary card — on the page, where there's
          no card, "doesn't describe itself" is a note about nothing. */}
      {!fill && data && !data.binary && data.summary === null ? (
        <div className={styles.hint}>This file doesn&rsquo;t describe itself.</div>
      ) : null}

      {data ? (
        <div className={styles.meta}>
          {formatBytes(data.size)}
          {!data.binary ? ` · ${data.lines.toLocaleString()} lines` : null}
          {data.truncated ? ' · showing the first part only' : null}
        </div>
      ) : null}

      {data?.binary ? <div className={styles.hint}>Binary file — nothing to read here.</div> : null}

      {data?.content ? (
        <pre className={[styles.code, fill ? styles.codeFill : ''].filter(Boolean).join(' ')}>
          <code>{data.content}</code>
        </pre>
      ) : null}

      {data?.truncated ? (
        <div className={styles.hint}>
          Truncated at {formatBytes(data.content?.length ?? 0)} — open it in the editor for the rest.
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
