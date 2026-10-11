/**
 * useTablesData.ts — TanStack Query wiring for the research tables page
 * (TablesPage.tsx, HazardMap.tsx, TableDetail.tsx), over the endpoints in
 * api.ts that routes/research_tables.py serves.
 *
 * Everything the page shows is keyed under ['research', 'tables'…], so any
 * write — a review, a new table, a moved hazard — invalidates that one prefix
 * and every grid, cell and detail on screen refetches together. Simpler than
 * patching each cache by hand, and these are small reads.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as apiR from './api';
import { researchErrorMessage } from './api';
import type { NewTableBody, Review, VerdictKey } from './types';

const ROOT = ['research', 'tables'] as const;
export const tablesKey = [...ROOT, 'list'] as const;
export const tableViewKey = (id: number, allFoods: boolean) => [...ROOT, 'view', id, allFoods] as const;
export const hazardsKey = [...ROOT, 'hazards'] as const;
export const measureKey = (id: number) => [...ROOT, 'measure', id] as const;
export const judgmentKey = (id: number) => [...ROOT, 'judgment', id] as const;

type PushToast = (message: string, opts?: { tone?: 'error' | 'info' }) => void;

export function useTables() {
  return useQuery({ queryKey: tablesKey, queryFn: ({ signal }) => apiR.getTables(signal), staleTime: 10_000 });
}

export function useTableView(id: number | null, allFoods: boolean) {
  return useQuery({
    queryKey: tableViewKey(id ?? 0, allFoods),
    queryFn: ({ signal }) => apiR.getTableView(id!, allFoods, signal),
    enabled: id !== null,
    staleTime: 5_000,
  });
}

export function useHazards() {
  return useQuery({ queryKey: hazardsKey, queryFn: ({ signal }) => apiR.getHazards(signal), staleTime: 10_000 });
}

export function useMeasure(id: number) {
  return useQuery({ queryKey: measureKey(id), queryFn: ({ signal }) => apiR.getMeasure(id, signal) });
}

export function useJudgment(id: number) {
  return useQuery({ queryKey: judgmentKey(id), queryFn: ({ signal }) => apiR.getJudgment(id, signal) });
}

/** Every write the page makes. Each refreshes everything under the tables
 * prefix on success and says what went wrong, in the server's words, on failure. */
export function useTablesMutations(push: PushToast) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ROOT });
  const fail = (fallback: string) => (error: unknown) =>
    push(researchErrorMessage(error, fallback), { tone: 'error' });

  return {
    reviewMeasure: useMutation({
      mutationFn: ({ id, review }: { id: number; review: Review }) => apiR.reviewMeasure(id, review),
      onSuccess: refresh,
      onError: fail('Could not save the review.'),
    }),
    reviewJudgment: useMutation({
      mutationFn: ({ id, review }: { id: number; review: Review }) => apiR.reviewJudgment(id, review),
      onSuccess: refresh,
      onError: fail('Could not save the review.'),
    }),
    setJudgment: useMutation({
      mutationFn: (body: { food: number; lens: string; verdict: VerdictKey; hazard?: number | null; reasoning?: string }) =>
        apiR.setJudgment(body),
      onSuccess: refresh,
      onError: fail('Could not save the verdict.'),
    }),
    addTable: useMutation({
      mutationFn: (body: NewTableBody) => apiR.addTable(body),
      onSuccess: refresh,
      onError: fail('Could not make the table.'),
    }),
    deleteTable: useMutation({
      mutationFn: (id: number) => apiR.deleteTable(id),
      onSuccess: refresh,
      onError: fail('Could not delete the table.'),
    }),
    addHazard: useMutation({
      mutationFn: ({ name, parents }: { name: string; parents: number[] }) => apiR.addHazard(name, parents),
      onSuccess: refresh,
      onError: fail('Could not add the hazard.'),
    }),
    seedHazards: useMutation({
      mutationFn: () => apiR.seedHazards(),
      onSuccess: refresh,
      onError: fail('Could not plant the starter map.'),
    }),
    updateHazard: useMutation({
      mutationFn: ({ id, ...fields }: { id: number; name?: string; parents?: number[]; aliases?: string[] }) =>
        apiR.updateHazard(id, fields),
      onSuccess: refresh,
      onError: fail('Could not change the hazard.'),
    }),
    deleteHazard: useMutation({
      mutationFn: (id: number) => apiR.deleteHazard(id),
      onSuccess: refresh,
      onError: fail('Could not remove the hazard.'),
    }),
  };
}
