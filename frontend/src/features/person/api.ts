// api.ts — the person page's three server calls, over the shared fetch client.
// Endpoints live in routes/person.py; the response shapes in types.ts.

import { api } from '../../api/client';
import type { FactsResponse, PersonResponse, SummarizeResponse } from './types';

/** GET /api/person/<slug> — the whole picture for one person. */
export function getPerson(slug: string, signal?: AbortSignal): Promise<PersonResponse> {
  return api.get<PersonResponse>(`/api/person/${encodeURIComponent(slug)}`, signal);
}

/**
 * POST /api/person/<slug>/facts — replace the frontmatter facts with this
 * map (empty/whitespace-only values delete the key server-side). Returns the
 * re-serialized facts, which become the new source of truth for the UI.
 */
export function savePersonFacts(slug: string, facts: Record<string, string>): Promise<FactsResponse> {
  return api.post<FactsResponse>(`/api/person/${encodeURIComponent(slug)}/facts`, { facts });
}

/**
 * POST /api/person/<slug>/summarize — spawns (or reuses) the "person" tmux
 * Claude session server-side and types the impression-drafting prompt into
 * it. Slow: ensure_claude_session boots Claude Code and send_prompt waits a
 * settle delay before returning — the caller must show a pending state.
 */
export function summarizePerson(slug: string): Promise<SummarizeResponse> {
  return api.post<SummarizeResponse>(`/api/person/${encodeURIComponent(slug)}/summarize`);
}
