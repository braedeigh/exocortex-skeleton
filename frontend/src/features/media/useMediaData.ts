import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import { addMediaItem, getMediaData, removeMediaItem, updateMediaItem } from './api';
import type { MediaItemFields, MediaItemPatch } from './api';
import { applyMediaAdd, applyMediaRemove, applyMediaUpdate } from './optimistic';
import type { MediaData, MediaItem } from './types';

export const MEDIA_QUERY_KEY = ['data', 'media'] as const;

/** Primary data — polled every 5s, like the old dashboard's loadDashboard loop. */
export function useMediaData() {
  return useQuery({
    queryKey: MEDIA_QUERY_KEY,
    queryFn: ({ signal }) => getMediaData(signal),
    refetchInterval: 5000,
  });
}

/** Like todos' useToasts, but accepts full ToastItem fields so the remove
 * flow can push an info toast with an Undo action. */
export function useMediaToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: string | Omit<ToastItem, 'id'>) => {
      const id = nextId.current++;
      const item: ToastItem = typeof toast === 'string' ? { id, message: toast } : { id, ...toast };
      setToasts((cur) => [...cur, item]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

/** Same shape as todos' useOptimisticMutation, specialized to the media cache. */
function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: MediaData, vars: TVars) => MediaData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: MediaData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: MEDIA_QUERY_KEY });
      const previous = queryClient.getQueryData<MediaData>(MEDIA_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MediaData>(MEDIA_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MEDIA_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MEDIA_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

export function useMediaActions(onError: (message: string) => void) {
  const add = useOptimisticMutation(
    (vars: { fields: MediaItemFields; tempItem: MediaItem }) => addMediaItem(vars.fields),
    (data, vars) => applyMediaAdd(data, vars.tempItem),
    onError,
  );
  const update = useOptimisticMutation(
    (patch: MediaItemPatch) => updateMediaItem(patch),
    (data, patch) => applyMediaUpdate(data, patch),
    onError,
  );
  const remove = useOptimisticMutation(
    (id: string) => removeMediaItem(id),
    (data, id) => applyMediaRemove(data, id),
    onError,
  );

  return {
    add: (fields: MediaItemFields) => {
      const tempItem: MediaItem = {
        id: tempId(),
        ...fields,
        done: fields.done ?? false,
        date: fields.date || null,
      };
      add.mutate({ fields, tempItem });
    },
    update: (patch: MediaItemPatch) => update.mutate(patch),
    toggleDone: (id: string, done: boolean) => update.mutate({ id, done }),
    remove: (id: string) => remove.mutate(id),
  };
}
