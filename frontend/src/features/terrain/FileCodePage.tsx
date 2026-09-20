import { FileCodeBody } from './FileCodeBody';
import { mentionsFromSearch } from './codeMentions';
import styles from './FileCodePage.module.css';

/**
 * /code?repo=…&path=…&lines=… — one file, read-only, as a whole page.
 *
 * WHY IT EXISTS (her 07-27 ask): "make it such that I can click a file in my
 * observatory in the files listed under the session and it opens that file on
 * the right side of the split screen." On desktop the left pane is the
 * observatory and the right pane is whatever the router is showing — so
 * "opens on the right" is just a navigation. A session card's file list
 * (features/observatory/SessionLane.tsx) routes here; this page is what lands
 * in the right pane. On mobile there's no split, so it's simply the file,
 * full-bleed, with back returning to the roster.
 *
 * The contents are FileCodeBody, the same component the terrain map's
 * tap-a-node modal wears — this file is the page frame around it: a header
 * carrying the filename, which repo it's in, and nothing else.
 *
 * `lines` is the route's raw "140" / "140-162" search param (routes/code.tsx
 * already validated its shape); `parseLineRange` turns it into the 1-based
 * inclusive {start, end} FileCodeBody highlights and scrolls to on mount. A
 * bare number highlights just that one line.
 *
 * `mentions` + `of` are the other way in: every line this file names one SQL
 * table on, sent by that table's card on the Terrain map. The body marks them
 * all, lands on the first, and puts arrows above the code to step between them
 * (codeMentions.ts spells the params; FileCodeBody does the stepping).
 */
function parseLineRange(lines?: string): { start: number; end: number } | undefined {
  if (!lines) return undefined;
  const [a, b] = lines.split('-');
  const start = Number(a);
  if (!Number.isFinite(start) || start < 1) return undefined;
  const end = b !== undefined ? Math.max(start, Number(b)) : start;
  return { start, end: Number.isFinite(end) ? end : start };
}

export function FileCodePage({
  repo,
  path,
  lines,
  mentions,
  of,
}: {
  repo?: string;
  path?: string;
  lines?: string;
  /** Comma-separated 1-based lines that all name `of`, e.g. "4,9,30". */
  mentions?: string;
  /** What those lines name — a SQL table's name. */
  of?: string;
}) {
  // Nothing asked for yet — a bare /code, or a link that lost its search.
  if (!repo || !path) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          Pick a file from a session in the Observatory and it opens here.
        </div>
      </div>
    );
  }

  const name = path.split('/').filter(Boolean).slice(-1)[0] ?? path;

  return (
    <div className={styles.page}>
      {/* Filename, which repo it's in, then where it sits — all on one line
          (her 07-27 ask: "I want the file path to go up at the top next to the
          title of the file"). The path is the only part that flexes, so it's
          what ellipsizes in a narrow pane, and it wraps to its own line before
          it gets squeezed to nothing. */}
      <div className={styles.header}>
        <h1 className={styles.title}>{name}</h1>
        <span className={styles.repo}>{repo}</span>
        <span className={styles.headerPath} title={path}>
          {path}
        </span>
      </div>
      {/* keyed on file + line range so switching files (or clicking a new
          lines= link to the SAME file) remounts clean — otherwise the
          scroll-once guard in FileCodeBody would fire for the first link and
          never fire again for the second. The mentions are in the key for the
          same reason: a second table's card pointing at this same file should
          land on ITS first mention, not stay where the last one left her. */}
      <FileCodeBody
        key={`${repo}:${path}:${lines ?? ''}:${mentions ?? ''}`}
        repo={repo}
        path={path}
        fill
        highlight={parseLineRange(lines)}
        mentions={mentionsFromSearch(mentions, of)}
      />
    </div>
  );
}
