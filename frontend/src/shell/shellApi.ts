/**
 * shellApi.ts — API-call helpers for the terminal-pane widgets (panel notes,
 * scheduled prompts, upload, activity). Kept out of src/api/endpoints.ts on
 * purpose (that file is owned elsewhere); everything the terminal pane needs
 * to call lives here instead, on top of the same `api` client every other
 * feature uses.
 */
import { api } from '../api/client';

// --- Panel notes (dev_notes.json, one tab per room) --------------------------
// Backend: routes/devnotes.py

export interface DevNote {
  id: string;
  text: string;
  created: string;
}

// Which dev-notes section a 📝 panel files under. Each room that mounts the
// panel names its own tab, so a note written on the Terrain map lands under
// 'terrain' and one written beside a conversation lands under 'terminal' —
// two rooms never share a list by accident. Tab names are free-form on the
// backend (a new one is created on first write), so adding a room here needs
// no server change.
// Prompt: "unlink them and give the terrain room its own dev notes section"
export type PanelNotesTab = 'terminal' | 'terrain';

export function getPanelNotes(tab: PanelNotesTab, signal?: AbortSignal): Promise<{ tab: string; notes: DevNote[] }> {
  return api.get(`/api/devnotes/${tab}`, signal);
}

export function addPanelNote(tab: PanelNotesTab, text: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/add', { tab, text });
}

export function editPanelNote(tab: PanelNotesTab, id: string, text: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/edit', { tab, id, text });
}

export function removePanelNote(tab: PanelNotesTab, id: string): Promise<{ ok: true }> {
  return api.post('/api/devnote/remove', { tab, id });
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
// the card shows it instead of a recap. Live rw-* worker sessions are
// included with worker: true.

export interface SessionRecap {
  recap: string | null;
  source: 'assistant' | 'compact' | 'pane' | null;
  status: string | null; // claude process status ('busy', 'idle', …), 'not-running', or null for a plain shell
  error: string | null;
  updatedAt: number | null; // transcript mtime, epoch seconds
  needsInput: boolean;
  worker: boolean;
}

export function getSessionRecaps(signal?: AbortSignal): Promise<{ sessions: Record<string, SessionRecap> }> {
  return api.get('/api/terminal/recaps', signal);
}
