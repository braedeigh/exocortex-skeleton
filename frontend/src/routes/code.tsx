import { createFileRoute, redirect } from '@tanstack/react-router';
import { FileCodePage } from '../features/terrain/FileCodePage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /code?repo=…&path=… — read one file from either repo.
 *
 * This is the target the Observatory's session cards link their file lists at:
 * on desktop the observatory sits in the split's LEFT pane and the router owns
 * the right one, so "click a file, it opens on the right" is a plain
 * navigation to here. Deep-linkable and reloadable — the file is entirely
 * described by the two search params (routes/spa.py serves the shell at /code
 * so a hard reload lands back on it).
 *
 * Auth-only, same guard as /terrain and /observatory: it reads repo source, so
 * public visitors bounce to '/'.
 */
export interface CodeSearch {
  /** Terrain repo id the path is relative to — 'skeleton' | 'vault'. */
  repo?: string;
  /** Repo-relative path, e.g. "routes/observatory.py". */
  path?: string;
}

export const Route = createFileRoute('/code')({
  validateSearch: (search: Record<string, unknown>): CodeSearch => ({
    repo: typeof search.repo === 'string' && search.repo !== '' ? search.repo : undefined,
    path: typeof search.path === 'string' && search.path !== '' ? search.path : undefined,
  }),
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: CodeRoute,
});

function CodeRoute() {
  useDeactivateFrames();
  const { repo, path } = Route.useSearch();
  return <FileCodePage repo={repo} path={path} />;
}
