/**
 * fileEditApi.ts — the typed door to /api/file-edit (routes/file_edit.py).
 *
 * What this is, in plain English: the /code page's Edit button reads a file
 * through here and saves her change back. And a session that needs her to
 * fill something in can ask her to open a file (scripts/open_file.py); this
 * polls those requests for the orange card and lets her turn one down.
 *
 * A file's text is never cached: the editor reads it fresh each time it
 * opens, because it can be a settings file and because it must be the file as
 * it is on disk right now.
 *
 * Touches: routes/file_edit.py, FileEditor.tsx, FileRequestCard.tsx,
 * FileRequestHost.tsx, the Observatory roster.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../../api/client';

export interface EditableFile {
  repo: string;
  path: string;
  content: string;
  /** What the file looked like when it was read. A save sends it back, and is
   * refused if the file has changed on disk since. */
  version: string;
}

export interface SaveResult {
  ok: boolean;
  version: string;
  /** How many sessions' requests this save answered. */
  woken: number;
}

export interface FileAsker {
  conv: string;
  title: string;
  reason: string;
  at: string;
}

export interface FileRequest {
  id: string;
  repo: string;
  path: string;
  created: string;
  askers: FileAsker[];
}

export const FILE_REQUESTS_KEY = ['file-requests'] as const;

/** GET /api/file-edit — the whole file as it is on disk. */
export function readFile(repo: string, path: string, signal?: AbortSignal) {
  return api.get<EditableFile>(
    `/api/file-edit?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    signal,
  );
}

/** POST /api/file-edit — save over the file; a 409 means it changed on disk. */
export function saveFile(repo: string, path: string, content: string, version: string) {
  return api.post<SaveResult>('/api/file-edit', { repo, path, content, version });
}

/** GET /api/file-edit/locate — a full path on this machine, as the repo and
 * path the file page opens it by. Rejects with the reason when the file is
 * outside every folder the page can read, or is gone. */
export function locateFile(path: string, signal?: AbortSignal) {
  return api.get<{ repo: string; path: string }>(
    `/api/file-edit/locate?path=${encodeURIComponent(path)}`,
    signal,
  );
}

/** Poll the queue every few seconds; paused while the tab is hidden. */
export function useFileRequests() {
  return useQuery({
    queryKey: FILE_REQUESTS_KEY,
    queryFn: ({ signal }) => api.get<{ open: FileRequest[] }>('/api/file-edit/requests', signal),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/** Turn a request down, refreshing the shared queue when it answers. */
export function useDismissFileRequest() {
  const client = useQueryClient();
  return useCallback(
    async (id: string) => {
      try {
        await api.post(`/api/file-edit/requests/${id}/dismiss`);
      } finally {
        void client.invalidateQueries({ queryKey: FILE_REQUESTS_KEY });
      }
    },
    [client],
  );
}

/** The address of a file's editor in its own tab: the /code page, solo, with
 * the editor already open (shell/solo.ts reads `solo`, routes/code.tsx `edit`). */
export function editorHref(repo: string, path: string): string {
  return `/code?${new URLSearchParams({ repo, path, edit: '1', solo: '1' }).toString()}`;
}
