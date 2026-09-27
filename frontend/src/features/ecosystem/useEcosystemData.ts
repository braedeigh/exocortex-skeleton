/**
 * useEcosystemData.ts — TanStack Query wiring for the Ecosystem tab.
 *
 * The old page re-fetched the whole dashboard after every save
 * (loadDashboard()); here mutations just invalidate the ecosystem query.
 * No optimistic cache writes: a source save closes the editor immediately
 * (local state) and the invalidate/5s poll paints the marker — same feel as
 * the old flow, without duplicating the server's payload normalization.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { addSource, getEcosystemData, linkSource, removeSource, unlinkSource, updateSource } from './api';
import type { SourcePayload } from './api';

export const ECOSYSTEM_QUERY_KEY = ['data', 'ecosystem'] as const;

export function useEcosystemData() {
  return useQuery({
    queryKey: ECOSYSTEM_QUERY_KEY,
    queryFn: ({ signal }) => getEcosystemData(signal),
    refetchInterval: 5000,
  });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function useSourceMutations(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ECOSYSTEM_QUERY_KEY });

  const save = useMutation({
    mutationFn: (payload: SourcePayload) => (payload.id ? updateSource(payload) : addSource(payload)),
    onError: (err) => onError(errorMessage(err, 'Save failed.')),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeSource(id),
    onError: (err) => onError(errorMessage(err, 'Delete failed.')),
    onSuccess: invalidate,
  });

  // Link / unlink a food or product to a source — the join the map traces by.
  const link = useMutation({
    mutationFn: (v: { sourceId: string; target: { food?: number; product_id?: number } }) =>
      linkSource(v.sourceId, v.target),
    onError: (err) => onError(errorMessage(err, 'Link failed.')),
    onSuccess: invalidate,
  });

  const unlink = useMutation({
    mutationFn: (linkId: number) => unlinkSource(linkId),
    onError: (err) => onError(errorMessage(err, 'Unlink failed.')),
    onSuccess: invalidate,
  });

  return { save, remove, link, unlink };
}
