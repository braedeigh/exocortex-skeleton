import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, IconButton } from '../../ui';
import { isSolo } from '../../shell/solo';
import { isStandalone } from '../../shell/standalone';
import { FileEditor } from '../fileedit/FileEditor';
import { FileCodeBody } from './FileCodeBody';
import { mentionsFromSearch } from './codeMentions';
import styles from './FileCodePage.module.css';

/**
 * /code?repo=…&path=…&lines=… — one file as a whole page: read-only, with an
 * Edit button for the owner.
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
 *
 * EDIT: the header's Edit button swaps the code for a text box she can change
 * and save (features/fileedit/FileEditor.tsx); `edit` in the address opens it
 * that way from the start, which is how a session's "file to edit" card hands
 * her a file. The editor also opens settings files the read-only view refuses
 * (`.env` and the like): for those the read-only view still shows its "couldn't
 * load", and Edit is how she sees them. Not for visitors, and not in the
 * desktop app, whose server has no save door.
 *
 * In a SOLO tab (a file popped out of the Terrain map — shell/solo.ts) the
 * header also wears an ×. A popped-out tab starts with no history, so there
 * is nowhere to go "back" to; the × goes to the Terrain map instead, still
 * solo, so the tab stays one pane.
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
  edit,
}: {
  repo?: string;
  path?: string;
  lines?: string;
  /** Comma-separated 1-based lines that all name `of`, e.g. "4,9,30". */
  mentions?: string;
  /** What those lines name — a SQL table's name. */
  of?: string;
  /** Open with the editor up — the "file to edit" card's link. */
  edit?: boolean;
}) {
  const navigate = useNavigate();
  const solo = isSolo();
  // Editing is the owner's: a visitor's page and the desktop app never offer it.
  const canEdit =
    typeof window !== 'undefined' && window.VIEW_MODE !== 'public' && !isStandalone();
  const [editing, setEditing] = useState(Boolean(edit) && canEdit);

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
        {/* Leave a popped-out file for the Terrain map. Only a solo tab gets
            this ×: anywhere else the page sits in a tile or behind the tab
            strip, which already have their own ways out. The tab was opened
            fresh, so it has no "back" — the × goes to the map, the place the
            file was popped out of. `solo` is carried along so the map gets
            the whole tab too, instead of the full workspace appearing around
            it; a file tapped there opens over it, and ITS × comes back.
            A push, so the browser's back button returns to this file.
            Her ask: "when I open the new window, and there is no x button,
            it takes me to a terrain view." */}
        {canEdit && !editing ? (
          <Button
            type="button"
            variant="secondary"
            className={styles.headerEdit}
            data-track="code-edit"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        ) : null}
        {solo ? (
          <IconButton
            className={styles.headerClose}
            aria-label="Close — go to the Terrain map"
            title="Go to the Terrain map"
            data-track="code-solo-to-terrain"
            onClick={() => void navigate({ to: '/terrain/files', search: { solo: true } })}
          >
            &times;
          </IconButton>
        ) : null}
      </div>
      {/* keyed on file + line range so switching files (or clicking a new
          lines= link to the SAME file) remounts clean — otherwise the
          scroll-once guard in FileCodeBody would fire for the first link and
          never fire again for the second. The mentions are in the key for the
          same reason: a second table's card pointing at this same file should
          land on ITS first mention, not stay where the last one left her. */}
      {editing ? (
        <FileEditor key={`${repo}:${path}`} repo={repo} path={path} onDone={() => setEditing(false)} />
      ) : (
        <FileCodeBody
          key={`${repo}:${path}:${lines ?? ''}:${mentions ?? ''}`}
          repo={repo}
          path={path}
          fill
          highlight={parseLineRange(lines)}
          mentions={mentionsFromSearch(mentions, of)}
        />
      )}
    </div>
  );
}
