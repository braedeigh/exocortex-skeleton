/**
 * shellApi.ts — API-call helpers for the terminal-pane widgets (notes,
 * scheduled prompts, upload, activity). Kept out of src/api/endpoints.ts on
 * purpose (that file is owned elsewhere); everything the terminal pane needs
 * to call lives here instead, on top of the same `api` client every other
 * feature uses.
 */
import { api } from '../api/client';

// --- Terminal notes (dev_notes.json, tab 'terminal') ------------------------
// Backend: routes/devnotes.py

export interface DevNote {
  id: string;
  text: string;
  created: string;
}

export function getTermNotes(signal?: AbortSignal): Promise<{ tab: string; notes: DevNote[] }> {
  return api.get('/api/devnotes/terminal', signal);
}

export function addTermNote(text: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/add', { tab: 'terminal', text });
}

export function editTermNote(id: string, text: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/edit', { tab: 'terminal', id, text });
}

export function removeTermNote(id: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/remove', { tab: 'terminal', id });
}

// --- Scheduled prompts (scheduled_prompts.json) ------------------------------
// Backend: routes/terminal.py

export interface ScheduledJob {
  id: string;
  session: string;
  prompt: string;
  at: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed' | string;
  created: string;
  sent_at: string | null;
}

export function getScheduledJobs(signal?: AbortSignal): Promise<{ jobs: ScheduledJob[] }> {
  return api.get('/api/terminal/schedule', signal);
}

export function addScheduledJob(body: {
  session: string;
  prompt: string;
  at: string; // "YYYY-MM-DD HH:MM"
}): Promise<{ ok: true; job: ScheduledJob }> {
  return api.post('/api/terminal/schedule/add', body);
}

export function cancelScheduledJob(id: string): Promise<{ ok: true; job: ScheduledJob }> {
  return api.post('/api/terminal/schedule/cancel', { id });
}

// --- Upload -------------------------------------------------------------------
// Backend: routes/terminal.py — multipart form, field name 'photo' (legacy name).

export interface UploadResult {
  paths: string[];
  path: string;
}

export async function uploadTerminalFile(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('photo', file);
  const res = await fetch('/api/terminal/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<UploadResult> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  return data as UploadResult;
}

/** Paste an uploaded file's path into a terminal session, same as split.html did. */
export function sendUploadRefToTerminal(path: string, session: string): Promise<{ ok: true }> {
  return api.post('/api/terminal/send', { text: `[uploaded: ${path}]`, enter: false, session });
}

// --- Activity ("needs input") -------------------------------------------------
// Backend: routes/terminal.py

export function getNeedsInput(signal?: AbortSignal): Promise<{ sessions: Record<string, boolean> }> {
  return api.get('/api/terminal/needs-input', signal);
}

// --- Session recaps (the /sessions full-page switcher) --------------------------
// Backend: routes/terminal.py — recap comes from the pane's Claude Code
// transcript ('assistant' = its last message, 'compact' = a compaction recap)
// or the raw pane tail for plain shells ('pane'). `error` is set when the
// transcript couldn't be parsed (Claude Code's internal format changed) —
// the card shows it instead of a recap.

export interface SessionRecap {
  recap: string | null;
  source: 'assistant' | 'compact' | 'pane' | null;
  status: string | null; // claude process status ('busy', 'idle', …), 'not-running', or null for a plain shell
  error: string | null;
}

export function getSessionRecaps(signal?: AbortSignal): Promise<{ sessions: Record<string, SessionRecap> }> {
  return api.get('/api/terminal/recaps', signal);
}
