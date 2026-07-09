/**
 * api.ts — Ideas-tab endpoints not already covered by src/api/endpoints.ts
 * (which has the /api/ideanote add/edit/remove + /api/ideanotes/all set used
 * by the notes pill and /notes browser). Here: the IDEAS.md vision doc
 * (routes/ideas.py) and the undo-restore for deleted idea notes
 * (routes/devnotes.py).
 */
import { api } from '../../api/client';
import type { OkResponse } from '../../api/endpoints';
import type { DevNote } from '../journal/types';

export interface IdeasDocResponse {
  /** Raw IDEAS.md markdown; empty string when the doc doesn't exist yet. */
  content: string;
}

/** GET /api/ideas — the raw vision doc. */
export function getIdeasDoc(signal?: AbortSignal): Promise<IdeasDocResponse> {
  return api.get('/api/ideas', signal);
}

/** POST /api/ideas — whole-doc save. The server refuses an empty body when a
 * non-empty doc exists (a blank editor is more likely a glitched load than an
 * intentional wipe) — that arrives as an ApiError with the server's message. */
export function saveIdeasDoc(content: string): Promise<OkResponse> {
  return api.post('/api/ideas', { content });
}

/** POST /api/ideanote/restore — undo of a delete: re-insert the full note
 * (id/created intact) at its original index. Restoring twice can't dup. */
export function restoreIdeaNote(tab: string, note: DevNote, index: number): Promise<OkResponse> {
  return api.post('/api/ideanote/restore', { tab, note, index });
}
