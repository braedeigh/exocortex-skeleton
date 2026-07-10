import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getKeeperFile, getKeeperTree, saveKeeperFile } from './api';

export const KEEPER_TREE_KEY = ['keeper', 'tree'] as const;

export function keeperFileKey(path: string) {
  return ['keeper', 'file', path] as const;
}

/** Legacy page polled every 4s to pick up the keeper agent's own edits. */
export const KEEPER_POLL_MS = 4000;

/** The whole vault tree — fetched on mount, invalidated after delete/restore
 * (the legacy page likewise only reloaded it on init and after undo). */
export function useKeeperTree() {
  return useQuery({
    queryKey: KEEPER_TREE_KEY,
    queryFn: ({ signal }) => getKeeperTree(signal),
  });
}

/**
 * The open file, live-polled (~4s) so the keeper's in-session edits show up.
 * `pausePolling` while the textarea is focused — and FileView additionally
 * only applies refreshed content when the editor isn't dirty, so a poll can
 * never clobber an in-progress edit (same discipline as useJournalDay).
 */
export function useKeeperFile(path: string | null, pausePolling: boolean) {
  return useQuery({
    queryKey: keeperFileKey(path ?? ''),
    queryFn: ({ signal }) => getKeeperFile(path as string, signal),
    enabled: !!path,
    refetchInterval: pausePolling ? false : KEEPER_POLL_MS,
  });
}

/** Debounced-autosave target; refreshes the file query so lastSaved and the
 * server agree right after a save. */
export function useSaveKeeperFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { path: string; content: string }) => saveKeeperFile(vars.path, vars.content),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: keeperFileKey(vars.path) });
    },
  });
}
