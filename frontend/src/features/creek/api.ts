/**
 * api.ts — typed reads for the creek: the overview (`GET /api/creek?days=14`)
 * plus four per-collection reads that back "the water" — the detail panel's
 * lazy Now/Changes/Writes sections. All five are coded exactly against the
 * contracts in the task brief, built in parallel against routes that don't
 * exist here yet.
 *
 * The overview query is the whole creek in one payload: every collection with
 * its traffic and callers, every file with its calls into those collections,
 * and the calls the server couldn't statically resolve.
 *
 * The four water hooks (`useCollectionNow/History/Diff/Writes`) are each
 * `enabled` only while their section is open — a collapsed section costs
 * nothing — and each is keyed and fetched by the raw collection id, NEVER
 * `encodeURIComponent`-ed, because an id like `bot_chats/index` is meant to
 * reach the server as two path segments, not one escaped one. Nothing here
 * writes anything; the creek is read-only, a map of flow and of the data
 * itself that already happened.
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

// --- the water: what a selected collection's data IS and WAS ----------------

/** `GET /api/creek/collection/<cid>/now` — the collection's current contents,
 * pretty-printed server-side and capped at 100k chars (`truncated` says so
 * honestly); `pretty` is null when `exists` is false. */
export interface CreekNow {
  id: string;
  backing: CreekBacking;
  exists: boolean;
  bytes: number;
  truncated: boolean;
  pretty: string | null;
}

/** One commit touching the collection's file/mirror. `added`/`removed` are
 * null when the server couldn't diff-stat it (e.g. a binary or missing
 * parent) — rendered muted rather than as a false zero. */
export interface CreekCommit {
  sha: string;
  ts: string;
  subject: string;
  added: number | null;
  removed: number | null;
}

/** `GET /api/creek/collection/<cid>/history` — hourly-batched git history.
 * `note` is the server's own honesty about that batching, shown verbatim.
 * `tracked` false means this collection has no git history for its file at
 * all (e.g. SQL-backed with no export mirror yet). */
export interface CreekHistory {
  id: string;
  file: string | null;
  tracked: boolean;
  note: string;
  commits: CreekCommit[];
}

/** `GET /api/creek/collection/<cid>/diff/<sha>` — one commit's unified diff
 * text, fetched lazily only once a commit row is tapped open. */
export interface CreekDiff {
  id: string;
  sha: string;
  diff: string;
  truncated: boolean;
}

/** One JSON-Patch-flavored op inside a write event. A note-only op (no
 * path/from/to) explains itself in plain English via `note` instead. */
export interface CreekPatchOp {
  op: string;
  path: string;
  from?: unknown;
  to?: unknown;
  note?: string | null;
}

/** One captured write to the collection. `patch` is null when the write
 * wasn't decomposed into ops (or predates capture); `truncated` means the
 * patch itself was capped, not the event list. */
export interface CreekWriteEvent {
  ts: string;
  caller: string;
  verb: string;
  patch: CreekPatchOp[] | null;
  truncated: boolean;
  bytes_before: number | null;
  bytes_after: number | null;
}

/** `GET /api/creek/collection/<cid>/writes` — the write journal. `note` is
 * the server's coverage honesty (what window it can actually see);
 * `capturing_since` is null until the journal has a start date for this
 * collection. */
export interface CreekWrites {
  id: string;
  capturing_since: string | null;
  events: CreekWriteEvent[];
  note: string;
}

/** The collection's current contents — only fetched while the Now section is
 * open. 30s stale: this is "what is it right now," worth refreshing sooner
 * than the map-wide reads. */
export function useCollectionNow(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['creek', 'now', id] as const,
    queryFn: ({ signal }) => api.get<CreekNow>(`/api/creek/collection/${id}/now`, signal),
    enabled,
    staleTime: 30_000,
  });
}

/** The collection's commit history — only fetched while Changes is open. */
export function useCollectionHistory(id: string, enabled: boolean, limit = 30) {
  return useQuery({
    queryKey: ['creek', 'history', id, limit] as const,
    queryFn: ({ signal }) =>
      api.get<CreekHistory>(`/api/creek/collection/${id}/history?limit=${limit}`, signal),
    enabled,
    staleTime: 60_000,
  });
}

/** One commit's diff — only fetched once a commit row is tapped open (`sha`
 * non-null) inside an already-open Changes section. */
export function useCollectionDiff(id: string, sha: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['creek', 'diff', id, sha] as const,
    queryFn: ({ signal }) => api.get<CreekDiff>(`/api/creek/collection/${id}/diff/${sha}`, signal),
    enabled: enabled && sha !== null,
    staleTime: 60_000,
  });
}

/** The collection's write journal — only fetched while Writes is open. */
export function useCollectionWrites(id: string, enabled: boolean, limit = 50) {
  return useQuery({
    queryKey: ['creek', 'writes', id, limit] as const,
    queryFn: ({ signal }) =>
      api.get<CreekWrites>(`/api/creek/collection/${id}/writes?limit=${limit}`, signal),
    enabled,
    staleTime: 30_000,
  });
}
