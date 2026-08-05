/**
 * api.ts — endpoints for the SQL lab. Matches routes/sqlab.py exactly.
 */

import { api } from '../../api/client';
import type { Collection, SandboxResponse, SqlResult, SqlTable, TypedTable } from './types';

export function getSchema(signal?: AbortSignal): Promise<{ tables: SqlTable[] }> {
  return api.get<{ tables: SqlTable[] }>('/api/sql/schema', signal);
}

export function runQuery(sql: string): Promise<SqlResult> {
  return api.post<SqlResult>('/api/sql/query', { sql });
}

/** Re-derive habits/habit_aliases/habit_entries from habits_log. */
export function rebuildHabits(): Promise<{ ok: boolean; habits: number }> {
  return api.post<{ ok: boolean; habits: number }>('/api/sql/rebuild', {});
}

export function getCollections(
  signal?: AbortSignal,
): Promise<{ blobs: Collection[]; typed: TypedTable[] }> {
  return api.get<{ blobs: Collection[]; typed: TypedTable[] }>('/api/sql/collections', signal);
}

// --- sandbox (routes/sandbox.py) — a separate, writable database ---

export function getSandboxSchema(signal?: AbortSignal): Promise<{ tables: SqlTable[] }> {
  return api.get<{ tables: SqlTable[] }>('/api/sandbox/schema', signal);
}

export function execSandbox(sql: string): Promise<SandboxResponse> {
  return api.post<SandboxResponse>('/api/sandbox/exec', { sql });
}

export function resetSandbox(): Promise<{ ok: boolean; dropped: number; tables: SqlTable[] }> {
  return api.post<{ ok: boolean; dropped: number; tables: SqlTable[] }>('/api/sandbox/reset', {});
}

export function bulkFill(rows: number): Promise<{ ok: boolean; rows: number; ms: number; tables: SqlTable[] }> {
  return api.post<{ ok: boolean; rows: number; ms: number; tables: SqlTable[] }>('/api/sandbox/bulk', { rows });
}
