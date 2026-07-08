/**
 * endpoints.ts — typed functions for what the app shell needs right now.
 * Payload types live in `./types` (vendored, formerly ts-rs output from
 * exo-core — see the header comment on each file there).
 */
import { api } from './client';
import type { TodayData, TodoItem } from '../features/todos/types';

/** GET /api/data/:tab — raw tab payload, shape TBD per-tab until exo-core ships types. */
export function getData(tab: string, signal?: AbortSignal): Promise<unknown> {
  return api.get(`/api/data/${tab}`, signal);
}

export interface VersionInfo {
  version: string;
  [key: string]: unknown;
}

/** GET /api/version */
export function getVersion(signal?: AbortSignal): Promise<VersionInfo> {
  return api.get('/api/version', signal);
}

/** GET /api/data/today */
export function getTodayData(signal?: AbortSignal): Promise<TodayData> {
  return api.get('/api/data/today', signal);
}

export interface AddTodoPayload {
  item: string;
  section: string;
  due_by?: string;
  notes?: string;
  due_time?: string;
  place_id?: string;
  category?: string;
  status?: string;
  theme?: string;
  duration_min?: number;
}

export interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

export interface AddTodoResponse extends OkResponse {
  id: string;
}

export function addTodo(payload: AddTodoPayload): Promise<AddTodoResponse> {
  return api.post('/api/todos/add', payload);
}

export function toggleTodo(id: string): Promise<OkResponse> {
  return api.post('/api/todos/toggle', { id });
}

export function removeTodo(id: string): Promise<OkResponse> {
  return api.post('/api/todos/remove', { id });
}

export function moveTodo(id: string, to_section: string): Promise<OkResponse> {
  return api.post('/api/todos/move', { id, to_section });
}

export function snoozeTodo(id: string, days: number): Promise<OkResponse> {
  return api.post('/api/todos/snooze', { id, days });
}

export function renameTodo(id: string, next: string): Promise<OkResponse> {
  return api.post('/api/todos/rename', { id, new: next });
}

export type TodoDetailsPatch = Partial<
  Pick<TodoItem, 'notes' | 'due_by' | 'due_time' | 'place_id' | 'category' | 'status' | 'theme' | 'duration_min'>
>;

export function todoDetails(id: string, patch: TodoDetailsPatch): Promise<OkResponse> {
  return api.post('/api/todos/details', { id, ...patch });
}

export function reorderTodos(section: string, items: string[]): Promise<OkResponse> {
  return api.post('/api/todos/reorder', { section, items });
}

export function autosortTodos(section: string): Promise<OkResponse> {
  return api.post('/api/todos/autosort', { section });
}

export function logActivity(date: string, type: string): Promise<OkResponse> {
  return api.post('/api/activity/log', { date, type });
}

export function removeActivity(date: string, type: string): Promise<OkResponse> {
  return api.post('/api/activity/remove', { date, type });
}

export function snoozeReminder(id: string, days: number): Promise<OkResponse> {
  return api.post('/api/reminders/snooze', { id, days });
}
