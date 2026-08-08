/**
 * endpoints.ts — typed functions for what the app shell needs right now.
 * Payload types live in `./types` (vendored, formerly ts-rs output from
 * exo-core — see the header comment on each file there).
 */
import { api } from './client';
import type { SymptomDefinitions, TodayData, TodoItem } from '../features/todos/types';
import type { StreakNote } from '../features/habits/types';
import type {
  AllNotesResponse,
  BacklinksResponse,
  Card,
  CardsResponse,
  DevNotesResponse,
  JournalDay,
  PeopleResponse,
} from '../features/journal/types';

/** GET /api/data/:tab — raw tab payload, shape TBD per-tab until exo-core ships types. */
export function getData(tab: string, signal?: AbortSignal): Promise<unknown> {
  return api.get(`/api/data/${tab}`, signal);
}

/** GET /api/data — the whole dashboard blob. Callers outside /today usually only want server_date. */
export interface AppData {
  server_date: string;
  [key: string]: unknown;
}

export function getAppData(signal?: AbortSignal): Promise<AppData> {
  return api.get('/api/data', signal);
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

export interface ClearedTodo {
  id: string;
  text: string;
  time?: string;
  fronts?: string[];
  /** Raw done_at, 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (legacy items stay date-only). */
  marked?: string;
  /** finished_note — optional completion note. */
  note?: string;
}

/** A done to-do whose completion moment lands on the queried day — the
 * journal stream interleaves these between entries by time. The moment is
 * the most precise thing she's claimed: finished_on + finished_time when
 * set, else the tap stamp's minute. Day-only values (legacy stamps, or a
 * claimed day without a time) have no position and never appear here. */
export interface MarkedTodo {
  id: string;
  text: string;
  /** 'HH:MM'. */
  time: string;
}

export interface ClearedTodosResponse {
  items: ClearedTodo[];
  marked_items: MarkedTodo[];
}

/** GET /api/todos/cleared?date= — done items whose effective completion day
 * (finished_on ?? done_at) is `date`; the journal day page's Cleared card. */
export function getClearedTodos(date: string, signal?: AbortSignal): Promise<ClearedTodosResponse> {
  return api.get(`/api/todos/cleared?date=${encodeURIComponent(date)}`, signal);
}

export interface AddTodoPayload {
  item: string;
  section: string;
  due_by?: string;
  notes?: string;
  due_time?: string;
  place_id?: string;
  fronts?: string[];
  duration_min?: number;
  after_date?: string;
  after_id?: string;
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
  Pick<
    TodoItem,
    | 'notes'
    | 'due_by'
    | 'due_time'
    | 'place_id'
    | 'fronts'
    | 'duration_min'
    | 'after_date'
    | 'after_id'
    | 'finished_on'
    | 'finished_time'
    | 'finished_note'
  >
>;

export function todoDetails(id: string, patch: TodoDetailsPatch): Promise<OkResponse> {
  return api.post('/api/todos/details', { id, ...patch });
}

export interface AddSubtaskResponse extends OkResponse {
  sub_id: string;
}

export function addSubtask(id: string, text: string): Promise<AddSubtaskResponse> {
  return api.post('/api/todos/subtask/add', { id, text });
}

export function toggleSubtask(id: string, sub_id: string): Promise<OkResponse> {
  return api.post('/api/todos/subtask/toggle', { id, sub_id });
}

export function removeSubtask(id: string, sub_id: string): Promise<OkResponse> {
  return api.post('/api/todos/subtask/remove', { id, sub_id });
}

/** One bulk operation for POST /api/todos/bulk — the discriminant is
 * `action`, and the extra fields ride along flat in the request body
 * (`{ids, action, ...}`), matching the route's open envelope. */
export type BulkTodoAction =
  | { action: 'details'; patch: TodoDetailsPatch }
  | { action: 'snooze'; days: number }
  | { action: 'move'; to_section: string }
  | { action: 'remove' };

export interface BulkTodoResponse extends OkResponse {
  updated: number;
  /** ids that matched nothing server-side (item vanished between poll and tap). */
  missing: string[];
}

export function bulkTodos(ids: string[], action: BulkTodoAction): Promise<BulkTodoResponse> {
  return api.post('/api/todos/bulk', { ids, ...action });
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

export function saveReminders(reminders: unknown[]): Promise<OkResponse> {
  return api.post('/api/reminders/save', { reminders });
}

// --- Symptoms (routes/health.py) ---

/** column -> 0..3 (nose_spray is 0/1). */
export type SymptomLevels = Record<string, number>;

export function logSymptoms(date: string, symptoms: SymptomLevels): Promise<OkResponse> {
  return api.post('/api/symptoms', { date, symptoms });
}

export function getSymptomDefinitions(signal?: AbortSignal): Promise<SymptomDefinitions> {
  return api.get('/api/symptom-definitions', signal);
}

// --- Streaks / day counters (routes/streaks.py) — identified by id ---

export function addStreak(label: string, since: string): Promise<OkResponse> {
  return api.post('/api/streaks/add', { label, since });
}

/** Patch a counter's description notes and/or habit link (habit_key: '' clears). */
export function updateStreak(
  id: string,
  patch: { notes?: string; habit_key?: string },
): Promise<OkResponse> {
  return api.post('/api/streaks/update', { id, ...patch });
}

export function removeStreak(id: string): Promise<OkResponse> {
  return api.post('/api/streaks/remove', { id });
}

export function retireStreak(id: string, note: string): Promise<OkResponse> {
  return api.post('/api/streaks/retire', { id, note });
}

export function unretireStreak(id: string): Promise<OkResponse> {
  return api.post('/api/streaks/unretire', { id });
}

export interface StreakNotesResponse {
  slug: string;
  tag: string;
  notes: StreakNote[];
}

export function getStreakNotes(slug: string, signal?: AbortSignal): Promise<StreakNotesResponse> {
  return api.get(`/api/streaks/${slug}/notes`, signal);
}

// --- Habits (daily view) — see routes/habits.py ---

export function toggleHabit(habit: string, section: string, date: string): Promise<OkResponse> {
  return api.post('/api/habits/toggle', { habit, section, date });
}

export function promoteHabitCadence(section: string, habit: string): Promise<OkResponse> {
  return api.post('/api/habits/cadence/promote', { section, habit });
}

export function restoreHabitCadence(section: string, habit: string): Promise<OkResponse> {
  return api.post('/api/habits/cadence/restore', { section, habit });
}

// TODO(habits phase 2): add/remove/move/reorder/rename/settings/configure —
// wire up once the habit config modal and tracker grid/edit mode land.

// --- Growth Notes ("Working On" aspirations) — see routes/habits.py ---
// Identified by `text` (no id), matching the legacy JS callers this mirrors.

export function addGrowthNote(text: string): Promise<OkResponse> {
  return api.post('/api/growth/add', { text });
}

export function removeGrowthNote(text: string): Promise<OkResponse> {
  return api.post('/api/growth/remove', { text });
}

export function incorporateGrowthNote(text: string): Promise<OkResponse> {
  return api.post('/api/growth/incorporate', { text });
}

export function reactivateGrowthNote(text: string): Promise<OkResponse> {
  return api.post('/api/growth/reactivate', { text });
}

// --- Journal (routes: server.py journal_*, routes/cards.py, routes/entities.py, routes/devnotes.py) ---

export interface JournalDatesResponse {
  dates: string[];
}

export function getJournalDates(signal?: AbortSignal): Promise<JournalDatesResponse> {
  return api.get('/api/journal/dates', signal);
}

export function getJournalDay(date: string, signal?: AbortSignal): Promise<JournalDay> {
  return api.get(`/api/journal/${date}`, signal);
}

export function saveJournalDay(date: string, content: string): Promise<OkResponse> {
  return api.post(`/api/journal/${date}`, { content });
}

export function getCards(date: string, signal?: AbortSignal): Promise<CardsResponse> {
  return api.get(`/api/cards/${date}`, signal);
}

export function updateCard(id: string, body: string): Promise<Card> {
  return api.post('/api/cards/update', { id, body });
}

// Tags are how a card joins a thread — these two are "add to thread" /
// "remove from thread" as far as the journal UI is concerned.
export function tagCard(id: string, tags: string[]): Promise<Card> {
  return api.post('/api/cards/tag', { id, tags });
}

export function untagCard(id: string, tags: string[]): Promise<Card> {
  return api.post('/api/cards/untag', { id, tags });
}

export function addCard(
  date: string,
  position: 'top' | 'bottom',
  body: string,
  tags?: string[],
  replyTo?: string,
): Promise<Card> {
  const payload: Record<string, unknown> = { date, position, body };
  if (tags && tags.length > 0) payload.tags = tags;
  if (replyTo) payload.reply_to = replyTo;
  return api.post('/api/cards/add', payload);
}

export function deleteCard(id: string): Promise<OkResponse> {
  return api.post('/api/cards/delete', { id });
}

export function getPeople(signal?: AbortSignal): Promise<PeopleResponse> {
  return api.get('/api/people', signal);
}

export function getBacklinks(name: string, signal?: AbortSignal): Promise<BacklinksResponse> {
  return api.get(`/api/backlinks?name=${encodeURIComponent(name)}`, signal);
}

export function getJournalDevNotes(signal?: AbortSignal): Promise<DevNotesResponse> {
  return api.get('/api/devnotes/journal', signal);
}

export function addJournalDevNote(text: string): Promise<OkResponse> {
  return api.post('/api/devnote/add', { tab: 'journal', text });
}

export function editJournalDevNote(id: string, text: string): Promise<OkResponse> {
  return api.post('/api/devnote/edit', { tab: 'journal', id, text });
}

export function removeJournalDevNote(id: string): Promise<OkResponse> {
  return api.post('/api/devnote/remove', { tab: 'journal', id });
}

// --- Dev notes / idea notes, generic tab-scoped (routes/devnotes.py) —
// backs the floating notes pill (src/features/todos/NotesPill.tsx) on any
// page, not just journal. ---

export function getDevNotes(tab: string, signal?: AbortSignal): Promise<DevNotesResponse> {
  return api.get(`/api/devnotes/${tab}`, signal);
}

/** GET /api/devnotes/all — every tab's dev notes at once. Backs /notes. */
export function getAllDevNotes(signal?: AbortSignal): Promise<AllNotesResponse> {
  return api.get('/api/devnotes/all', signal);
}

export function addDevNote(tab: string, text: string): Promise<OkResponse> {
  return api.post('/api/devnote/add', { tab, text });
}

export function editDevNote(tab: string, id: string, text: string): Promise<OkResponse> {
  return api.post('/api/devnote/edit', { tab, id, text });
}

export function removeDevNote(tab: string, id: string): Promise<OkResponse> {
  return api.post('/api/devnote/remove', { tab, id });
}

export function getIdeaNotes(tab: string, signal?: AbortSignal): Promise<DevNotesResponse> {
  return api.get(`/api/ideanotes/${tab}`, signal);
}

/** GET /api/ideanotes/all — every tab's idea notes at once. Backs /notes. */
export function getAllIdeaNotes(signal?: AbortSignal): Promise<AllNotesResponse> {
  return api.get('/api/ideanotes/all', signal);
}

export function addIdeaNote(tab: string, text: string): Promise<OkResponse> {
  return api.post('/api/ideanote/add', { tab, text });
}

export function editIdeaNote(tab: string, id: string, text: string): Promise<OkResponse> {
  return api.post('/api/ideanote/edit', { tab, id, text });
}

export function removeIdeaNote(tab: string, id: string): Promise<OkResponse> {
  return api.post('/api/ideanote/remove', { tab, id });
}
