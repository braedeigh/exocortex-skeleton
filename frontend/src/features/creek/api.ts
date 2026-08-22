/**
 * api.ts — typed read for the creek (`GET /api/creek?days=14`, built in
 * parallel — this file is coded exactly against the contract in the task
 * brief, not against a running endpoint).
 *
 * One query, one shape: the whole creek in a single payload — every collection
 * with its traffic and callers, every file with its calls into those
 * collections, and the calls the server couldn't statically resolve. Nothing
 * here writes anything; the creek is read-only, a map of flow that already
 * happened.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** Who touched a collection, and how — a person or an agent lane, not a file.
 * `file` is the source file that made the call, when the harvester could name
 * one; null when it couldn't. */
export interface CreekCaller {
  name: string;
  reads: number;
  writes: number;
  file: string | null;
}

export type CreekBacking = 'sql' | 'json';

export interface CreekCollection {
  id: string;
  backing: CreekBacking;
  reads: number;
  writes: number;
  callers: CreekCaller[];
}

export type CreekVerb = 'read' | 'write' | 'mutate';

/** One call site: a single line in a file that touches one collection. */
export interface CreekCall {
  line: number;
  verb: CreekVerb;
  collection: string;
  snippet: string;
}

export type CreekArea = 'routes' | 'server' | 'scripts' | 'tools';

export interface CreekFile {
  path: string;
  area: CreekArea;
  calls: CreekCall[];
}

/** A call the static scan found but couldn't resolve to a named collection —
 * shown as an honest count, never silently dropped. */
export interface CreekUnresolved {
  path: string;
  line: number;
  expr: string;
}

export interface CreekData {
  generated: string;
  days: number;
  collections: CreekCollection[];
  files: CreekFile[];
  unresolved: CreekUnresolved[];
}

/** The one read the creek makes. 60s stale — this is a map of recent history,
 * not a live view; nothing on the page needs it fresher than a minute. */
export function useCreek(days = 14) {
  return useQuery({
    queryKey: ['creek', days] as const,
    queryFn: ({ signal }) => api.get<CreekData>(`/api/creek?days=${days}`, signal),
    staleTime: 60_000,
  });
}
