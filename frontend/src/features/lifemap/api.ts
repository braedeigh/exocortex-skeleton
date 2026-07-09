/**
 * api.ts — Life Map endpoint helpers over the shared client. Mirrors the
 * fetch calls in static/js/{habits,activity,contacts,reminders}.js.
 */
import { api } from '../../api/client';
import type { MapData, ReminderDef } from './types';

export interface OkResponse {
  ok: boolean;
}

export function getMapData(signal?: AbortSignal): Promise<MapData> {
  return api.get<MapData>('/api/data/map', signal);
}

// --- Activity / runs / kitchen trips (activity.js) -------------------------

export function logActivity(date: string, type: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/activity/log', { date, type });
}

export function removeActivity(date: string, type: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/activity/remove', { date, type });
}

export function logRun(date: string, minutes: number | null, notes: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/runs/log', { date, minutes, notes });
}

export function removeRun(date: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/runs/remove', { date });
}

export function logKitchenTrip(date: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/kitchen/trips/log', { date });
}

export function removeKitchenTrip(date: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/kitchen/trips/remove', { date });
}

// --- Reminder registry (reminders.js) ---------------------------------------

export interface SaveRemindersResponse extends OkResponse {
  reminders: ReminderDef[];
}

/** Whole-registry save — the manager panel commits its draft in one shot. */
export function saveReminders(reminders: unknown[]): Promise<SaveRemindersResponse> {
  return api.post<SaveRemindersResponse>('/api/reminders/save', { reminders });
}

// --- Contacts (contacts.js) --------------------------------------------------

export function logContact(name: string, method: string, date?: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/log', date ? { name, method, date } : { name, method });
}

export function addContact(name: string, threshold_days: number): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/add', { name, threshold_days });
}

export function updateContactThreshold(name: string, threshold_days: number): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/update', { name, threshold_days });
}

export function reorderContacts(order: string[]): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/reorder', { order });
}

export function removeContact(name: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/remove', { name });
}

export function removeContactHistory(name: string, date: string, method: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/contacts/history/remove', { name, date, method });
}

// --- Habits (habits.js grid + edit mode) -------------------------------------

export function toggleHabitDate(habit: string, date: string, section: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/toggle', { habit, date, section });
}

export function removeHabit(item: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/remove', { item });
}

export function removeHabitDot(habit: string, date: string, section: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/toggle', { habit, date, section });
}

export function addHabit(item: string, section: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/add', { item, section });
}

export function moveHabit(item: string, to_section: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/move', { item, to_section });
}

export function reorderHabits(section: string, items: string[]): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/reorder', { section, items });
}

export function saveHabitSettings(hidden: string[]): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/settings', { hidden });
}

export function renameHabit(oldName: string, newName: string, section: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/rename', { old: oldName, new: newName, section });
}

export function promoteHabitCadence(section: string, habit: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/cadence/promote', { habit, section });
}

export function restoreHabitCadence(section: string, habit: string): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/cadence/restore', { habit, section });
}

export interface HabitConfigurePayload {
  name: string;
  sections?: string[];
  course_days?: number;
  remove?: boolean;
}

export function configureHabit(payload: HabitConfigurePayload): Promise<OkResponse> {
  return api.post<OkResponse>('/api/habits/configure', payload);
}
