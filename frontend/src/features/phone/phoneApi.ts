/**
 * phoneApi.ts — API helpers the mobile phone terminal needs that shellApi.ts
 * (owned by the shell) doesn't already provide. Same pattern: thin typed
 * wrappers over the shared `api` client, contracts from routes/terminal.py.
 * Multi-file photo upload lives here (shellApi's uploadTerminalFile is
 * single-file); text/key send, scroll, and refresh had no helper at all —
 * phone.html called fetch() inline.
 */
import { api } from '../../api/client';
import type { ScrollDirection } from './phoneLogic';

export interface SendResult {
  ok: true;
  /** Set when the text was >500 chars and got saved to a file instead —
   * the terminal received an `[uploaded: …]` ref (routes/terminal.py:166). */
  saved_to?: string;
}

/** Type `text` into a tmux session; `enter: true` also presses Enter. */
export function sendTerminalText(session: string, text: string, enter: boolean): Promise<SendResult> {
  return api.post('/api/terminal/send', { text, enter, session });
}

/** Press a special key (tmux `send-keys` name: Enter, Escape, C-c, Up…). */
export function sendTerminalKey(session: string, key: string): Promise<{ ok: true }> {
  return api.post('/api/terminal/send', { key, session });
}

export type ScrollMode = 'lines' | 'page' | 'end';

/**
 * Scroll a session's pane — the backend picks wheel events vs tmux copy-mode
 * per pane. `mode: 'lines'` takes a line count; `mode: 'end'` jumps to the
 * top/bottom of the scrollback.
 */
export function scrollTerminal(
  session: string,
  direction: ScrollDirection,
  mode: ScrollMode,
  lines?: number,
): Promise<{ ok: true }> {
  return api.post(
    '/api/terminal/scroll',
    lines === undefined ? { direction, mode, session } : { direction, mode, lines, session },
  );
}

/** tmux refresh-client — phone.html fired this 500ms after the ttyd iframe loads. */
export function refreshTerminal(session: string): Promise<{ ok: true }> {
  return api.post('/api/terminal/refresh', { session });
}

export interface PhotoUploadResult {
  paths: string[];
  path: string;
}

/**
 * Upload one request with every picked photo as a repeated multipart 'photo'
 * field (the legacy field name routes/terminal.py reads via getlist).
 */
export async function uploadTerminalPhotos(files: File[]): Promise<PhotoUploadResult> {
  const formData = new FormData();
  for (const f of files) formData.append('photo', f);
  const res = await fetch('/api/terminal/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<PhotoUploadResult> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `upload failed: ${res.status}`);
  }
  return data as PhotoUploadResult;
}
