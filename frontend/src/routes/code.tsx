import { createFileRoute, redirect } from '@tanstack/react-router';
import { FileCodePage } from '../features/terrain/FileCodePage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /code?repo=…&path=…&lines=… — read one file from either repo, optionally
 * with a line range highlighted and scrolled to.
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
 * Auth-only, same guard as /terrain and /observatory: it reads repo source, so
 * public visitors bounce to '/'.
 */
export interface CodeSearch {
  /** Terrain repo id the path is relative to — 'skeleton' | 'vault'. */
  repo?: string;
  /** Repo-relative path, e.g. "routes/observatory.py". */
  path?: string;
  /** 1-based line or line range to highlight, e.g. "140" or "140-162". */
  lines?: string;
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
  }),
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: CodeRoute,
});

function CodeRoute() {
  useDeactivateFrames();
  const { repo, path, lines } = Route.useSearch();
  return <FileCodePage repo={repo} path={path} lines={lines} />;
}
