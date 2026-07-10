/**
 * api.ts — the personality doc endpoints (server.py personality_get /
 * personality_save, backed by manifestation/goal-personality.md).
 */
import { api } from '../../api/client';
import type { OkResponse } from '../../api/endpoints';

export interface PersonalityDocResponse {
  /** Raw goal-personality.md markdown; empty string when the file doesn't exist yet. */
  content: string;
}

/** GET /api/personality — the whole raw doc. */
export function getPersonalityDoc(signal?: AbortSignal): Promise<PersonalityDocResponse> {
  return api.get('/api/personality', signal);
}

/** POST /api/personality — whole-doc save (section edits are spliced into the
 * full doc client-side, exactly like the legacy page). */
export function savePersonalityDoc(content: string): Promise<OkResponse> {
  return api.post('/api/personality', { content });
}
