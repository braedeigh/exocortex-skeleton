import { FileCodeBody } from './FileCodeBody';
import styles from './FileCodePage.module.css';

/**
 * /code?repo=…&path=… — one file, read-only, as a whole page.
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
 */
export function FileCodePage({ repo, path }: { repo?: string; path?: string }) {
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
      {/* keyed on the file so switching files remounts clean rather than
          showing the previous file's code under the new file's header */}
      <FileCodeBody key={`${repo}:${path}`} repo={repo} path={path} fill />
    </div>
  );
}
