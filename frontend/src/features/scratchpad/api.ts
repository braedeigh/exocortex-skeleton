/**
 * api.ts — scratchpad's server calls. Kept out of src/api/endpoints.ts on
 * purpose (that file is owned elsewhere — same pattern as shell/shellApi.ts);
 * built on the shared `api` client.
 *
 * Backend: routes/terminal.py — GET/POST /api/notes reads/writes
 * notes_dump.md in the data dir; POST /api/terminal/send types text into the
 * active tmux session.
 */
import { api } from '../../api/client';

export interface ScratchpadResponse {
  content?: string;
}

/** GET /api/notes — the whole scratchpad blob. */
export function getScratchpad(signal?: AbortSignal): Promise<ScratchpadResponse> {
  return api.get('/api/notes', signal);
}

/** POST /api/notes — overwrite the whole scratchpad blob. */
export function saveScratchpad(content: string): Promise<{ ok: true }> {
  return api.post('/api/notes', { content });
}

/**
 * The exact message legacy notes.html typed into the terminal — a *path
 * reference* to where /api/notes persists the dump (DATA_DIR/notes_dump.md),
 * not the notes text itself. Kept verbatim, em dash and all.
 */
export const NOTES_DUMP_MESSAGE = '[notes dump ready — read /opt/exocortex/personal/build/notes_dump.md]';

/**
 * POST /api/terminal/send with the legacy payload: `{text, enter: false}` and
 * no `session` key, so the backend targets the currently-active session
 * (routes/terminal.py _get_session falls back to TMUX_SESSION). The text is
 * pasted into the prompt but NOT submitted — she presses Enter herself.
 */
export function sendNotesDumpRef(): Promise<{ ok: true }> {
  return api.post('/api/terminal/send', { text: NOTES_DUMP_MESSAGE, enter: false });
}
