import { createFileRoute } from '@tanstack/react-router';
import { FileCodePage } from '../features/terrain/FileCodePage';
import { MENTIONS_PATTERN } from '../features/terrain/codeMentions';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /code?repo=…&path=…&lines=… — read one file from either repo, optionally
 * with a line range highlighted and scrolled to, or with every place it names
 * one SQL table marked and steppable (`mentions` + `of`).
 *
 * This is the target the Observatory's session cards link their file lists at:
 * on desktop the observatory sits in the split's LEFT pane and the router owns
 * the right one, so "click a file, it opens on the right" is a plain
 * navigation to here. Deep-linkable and reloadable — the file is entirely
 * described by the search params (routes/spa.py serves the shell at /code so
 * a hard reload lands back on it).
 *
 * `lines` is a single 1-based line number ("140") or an inclusive range
 * ("140-162") — e.g. /code?repo=skeleton&path=routes/todos.py&lines=140-162.
 * It's validated here against `^\d+(-\d+)?$`; anything else collapses to
 * undefined rather than crashing the page. FileCodePage does the actual
 * parsing into a {start, end} range for FileCodeBody to render.
 *
 * `mentions` is a comma-separated list of 1-based lines and `of` is what they
 * name — what a SQL table's card on the Terrain map sends when she opens one
 * of the files that touches it. The file lands on the first, marks the rest,
 * and gives her arrows to step between them. Same validation contract as
 * `lines`: a malformed list collapses to undefined (see
 * features/terrain/codeMentions.ts, which spells both ends of this param).
 *
 * Open to public visitors since 2026-09-22, like the map's own file pane: the
 * file endpoint behind it refuses anything but tracked app code to a stranger,
 * so the page itself needs no guard.
 */
export interface CodeSearch {
  /** Terrain repo id the path is relative to — 'skeleton' | 'vault'. */
  repo?: string;
  /** Repo-relative path, e.g. "routes/observatory.py". */
  path?: string;
  /** 1-based line or line range to highlight, e.g. "140" or "140-162". */
  lines?: string;
  /** 1-based lines that all name the same thing, e.g. "4,9,30". */
  mentions?: string;
  /** What those lines name — a SQL table's name. */
  of?: string;
  /** This window is the file and nothing else — a file popped out of the
   * Terrain map (shell/solo.ts reads it off the URL; the route never does).
   * It's in the schema only so the router doesn't strip it from the address
   * bar on load, which would drop the window back into the full workspace on
   * the next render. */
  solo?: boolean;
}

const LINES_PATTERN = /^\d+(-\d+)?$/;

export const Route = createFileRoute('/code')({
  validateSearch: (search: Record<string, unknown>): CodeSearch => ({
    repo: typeof search.repo === 'string' && search.repo !== '' ? search.repo : undefined,
    path: typeof search.path === 'string' && search.path !== '' ? search.path : undefined,
    lines:
      typeof search.lines === 'string' && LINES_PATTERN.test(search.lines)
        ? search.lines
        : undefined,
    mentions:
      typeof search.mentions === 'string' && MENTIONS_PATTERN.test(search.mentions)
        ? search.mentions
        : undefined,
    of: typeof search.of === 'string' && search.of !== '' ? search.of : undefined,
    ...(search.solo === '1' || search.solo === 1 || search.solo === true ? { solo: true } : {}),
  }),
  component: CodeRoute,
});

function CodeRoute() {
  useDeactivateFrames();
  const { repo, path, lines, mentions, of } = Route.useSearch();
  return <FileCodePage repo={repo} path={path} lines={lines} mentions={mentions} of={of} />;
}
