/**
 * setupApi.ts — the first-run screen's calls to the desktop server, and the
 * one flag it keeps in the browser.
 *
 * The routes exist only in the desktop app (standalone_app.py); on the normal
 * site they answer 404, so nothing here is called unless
 * shell/standalone.ts isStandalone() is true.
 *
 * Touches: setupCheck.ts (the shape of the answer), FirstRunPage.tsx and
 * routes/__root.tsx (the callers).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { readSetup, type StandaloneStatus } from './setupCheck';

const STATUS_KEY = ['standalone-status'] as const;

/** How often to re-ask while a download or a history read is running. */
const WORKING_POLL_MS = 2000;

/** Where the setup stands, asked once and then re-asked every two seconds
 * only while something is in progress. This is a poll that stops itself. */
export function useStandaloneStatus(enabled: boolean) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => api.get<StandaloneStatus>('/api/standalone', signal),
    enabled,
    retry: 1,
    staleTime: 10_000,
    refetchInterval: (query) => (readSetup(query.state.data ?? null).stillWorking ? WORKING_POLL_MS : false),
  });
}

/** The first-run screen's requests: the ways to give Terrain something to
 * draw, and the two settings. Each answers at once with the same status GET
 * returns; a download then goes on in the background. */
export function useProjectActions() {
  const queryClient = useQueryClient();
  const accept = (status: StandaloneStatus) => {
    queryClient.setQueryData(STATUS_KEY, status);
    return status;
  };
  return {
    /** Draw this app's own code. The server knows where it is. */
    drawOwnCode: () => api.post<StandaloneStatus>('/api/standalone/project', { own: true }).then(accept),
    /** Switch to a project that is already here. */
    drawProject: (id: string) => api.post<StandaloneStatus>('/api/standalone/project', { id }).then(accept),
    /** Draw a folder already on this computer. */
    drawFolder: (path: string) => api.post<StandaloneStatus>('/api/standalone/project', { path }).then(accept),
    /** Download a project from its git address, history included. */
    download: (url: string) => api.post<StandaloneStatus>('/api/standalone/project', { url }).then(accept),
    /** Choose whether NEW sessions stop and ask before changing anything. */
    setAsksFirst: (asksFirst: boolean) =>
      api.post<StandaloneStatus>('/api/standalone/settings', { ask_first: asksFirst }).then(accept),
    /** Choose whether a session left alone for a day is asked if it's done. */
    setChecksIdle: (checksIdle: boolean) =>
      api.post<StandaloneStatus>('/api/standalone/settings', { idle_check: checksIdle }).then(accept),
  };
}

/* Remember that setup was finished on this machine. Kept in the browser's
   storage because it's a fact about this window's user having seen the
   screen, not about the server. Storage that refuses is treated as "not
   finished", which only means the screen shows once more. */
const FINISHED_KEY = 'exo-desktop-setup-finished';

export function setupFinishedBefore(): boolean {
  try {
    return window.localStorage.getItem(FINISHED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markSetupFinished(): void {
  try {
    window.localStorage.setItem(FINISHED_KEY, '1');
  } catch {
    // ignore
  }
}
