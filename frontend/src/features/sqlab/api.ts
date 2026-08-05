/**
 * api.ts — endpoints for the SQL lab. Matches routes/sqlab.py exactly.
 */

import { api } from '../../api/client';
import type { SqlResult, SqlTable } from './types';

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
