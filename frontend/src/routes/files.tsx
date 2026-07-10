import { createFileRoute } from '@tanstack/react-router';
import { KeeperPage } from '../features/keeper/KeeperPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export interface FilesSearch {
  /**
   * Vault-relative path of a memory file to open, e.g. "people/sally.md".
   * This is THE deep-link contract for the Files tab — it replaces both the
   * legacy /keeper#<path> hash and the shell's keeper-open postMessage relay
   * (journal popovers, thread refs, etc. should navigate to /files?path=…).
   * A legacy location.hash path is still honored once on mount inside
   * KeeperPage, for old bookmarks.
   */
  path?: string;
}

export const Route = createFileRoute('/files')({
  component: FilesRoute,
  validateSearch: (search: Record<string, unknown>): FilesSearch => ({
    path: typeof search.path === 'string' && search.path !== '' ? search.path : undefined,
  }),
});

function FilesRoute() {
  useDeactivateFrames();
  return <KeeperPage />;
}
