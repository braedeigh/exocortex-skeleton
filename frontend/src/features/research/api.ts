/**
 * api.ts — every endpoint the research workspace talks to, one thin typed
 * helper each (same pattern as src/api/endpoints.ts, kept feature-local).
 * Backend: routes/research.py, research_sources.py, research_text.py,
 * research_search.py, research_import.py, annotations.py, the claims table
 * endpoints under /api/research/claims, plus server.py's GET /api/data/research.
 */

import { api, ApiError } from '../../api/client';
import type {
  AnnotationContent,
  AnnotationsResponse,
  ClaimDetailResponse,
  ClaimsListResponse,
  DocTextResponse,
  LibraryFileResponse,
  LibraryResponse,
  ResearchBlob,
  ResearchHealth,
  ResearchState,
  SearchHit,
  SourceClaimsResponse,
} from './types';

// --- State ---

/** GET /api/data/research -> {research: {topics, entries, sessions}, ...} */
export function getResearch(signal?: AbortSignal): Promise<{ research?: Partial<ResearchState> }> {
  return api.get('/api/data/research', signal);
}

/** GET /api/research/health -> worker-slot snapshot for the heartbeat pill. */
export function getResearchHealth(signal?: AbortSignal): Promise<ResearchHealth> {
  return api.get('/api/research/health', signal);
}

// --- Topics ---

export function addTopic(name: string, fronts?: string[]): Promise<ResearchBlob> {
  return api.post('/api/research/topic/add', fronts !== undefined ? { name, fronts } : { name });
}

export function editTopic(
  body: { id: string; name?: string; status?: string; fronts?: string[] },
): Promise<ResearchBlob> {
  return api.post('/api/research/topic/edit', body);
}

export function removeTopic(id: string): Promise<ResearchBlob> {
  return api.post('/api/research/topic/remove', { id });
}

// --- Entries ---

export interface AddEntryBody {
  text: string;
  kind: string;
  topics: string[];
  url?: string;
  reply_to?: string;
  re_quote?: string;
  context_ids?: string[];
}

export function addEntry(body: AddEntryBody): Promise<ResearchBlob> {
  return api.post('/api/research/entry/add', body);
}

export interface EditEntryBody {
  id: string;
  text?: string;
  url?: string;
  topics?: string[];
  verdict?: string;
  status?: string;
}

export function editEntry(body: EditEntryBody): Promise<ResearchBlob> {
  return api.post('/api/research/entry/edit', body);
}

export function removeEntry(id: string): Promise<ResearchBlob> {
  return api.post('/api/research/entry/remove', { id });
}

export function flagEntry(id: string, flagged: boolean): Promise<ResearchBlob> {
  return api.post('/api/research/entry/flag', { id, flagged });
}

export function reviewEntry(id: string, reviewed: boolean): Promise<ResearchBlob> {
  return api.post('/api/research/entry/review', { id, reviewed });
}

// --- Runner / deep / distill / batch sessions ---

/** ids === null means "send everything already flagged". */
export function sendEntries(ids: string[] | null): Promise<{ ok: boolean; sent: number; session: string | null }> {
  return api.post('/api/research/send', ids ? { ids } : {});
}

export function deepResearchQuestion(id: string): Promise<{ ok: boolean; session: string }> {
  return api.post('/api/research/question/deep', { id });
}

export function distillTopic(topic: string): Promise<ResearchBlob> {
  return api.post('/api/research/topic/distill', { topic });
}

export interface AnnotationBatchItem {
  reply_to: string;
  question: string;
  re_quote: string;
  context_ids: string[];
  mode: string;
}

export function annotationBatch(
  items: AnnotationBatchItem[],
): Promise<{ ok: boolean; count: number; session_ids: string[]; question_ids: string[] }> {
  return api.post('/api/research/annotation-batch', { items });
}

export function fileUnfiled(): Promise<{ ok: boolean; unfiled: number; session: string | null }> {
  return api.post('/api/research/file-unfiled');
}

// --- Source metadata (the "puller") ---

export function annotateSource(id: string): Promise<ResearchBlob> {
  return api.post('/api/research/entry/annotate', { id });
}

export function metaReview(id: string, reviewed: boolean): Promise<ResearchBlob> {
  return api.post('/api/research/entry/meta-review', { id, reviewed });
}

// --- Extracted full text ---

export function fetchEntryText(id: string): Promise<{ ok: boolean; doc: string; chars: number; strategy: string }> {
  return api.post('/api/research/entry/fetch-text', { id });
}

export function getDocTexts(signal?: AbortSignal): Promise<{ docs: string[] }> {
  return api.get('/api/research/texts', signal);
}

// --- Library ---

export function getLibrary(signal?: AbortSignal): Promise<LibraryResponse> {
  return api.get('/api/research/library', signal);
}

export function getLibraryFile(path: string, signal?: AbortSignal): Promise<LibraryFileResponse> {
  return api.get(`/api/research/library/file?path=${encodeURIComponent(path)}`, signal);
}

export interface ImportPlanItem {
  file: string;
  topic: string;
  questions: string[];
}

export function importQuestions(dryRun: boolean): Promise<{
  ok: boolean;
  dry_run?: boolean;
  plan?: ImportPlanItem[];
  total?: number;
  topics?: ResearchBlob['topics'];
  entries?: ResearchBlob['entries'];
  sessions?: ResearchBlob['sessions'];
}> {
  return api.post('/api/research/import-questions', dryRun ? { dry_run: true } : {});
}

// --- Search ---

export function searchResearch(q: string, mode: string, signal?: AbortSignal): Promise<{ hits: SearchHit[] }> {
  return api.get(`/api/research/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}`, signal);
}

// --- Annotations (generic doc-scoped layer) ---

export function getAnnotations(doc: string, signal?: AbortSignal): Promise<AnnotationsResponse> {
  return api.get(`/api/annotations?doc=${encodeURIComponent(doc)}`, signal);
}

export function getDocText(doc: string, signal?: AbortSignal): Promise<DocTextResponse> {
  return api.get(`/api/annotations/doc-text?doc=${encodeURIComponent(doc)}`, signal);
}

export function addAnnotation(body: {
  doc: string;
  char_start: number;
  char_end: number;
  content: AnnotationContent;
  needs_review?: boolean;
}): Promise<AnnotationsResponse> {
  return api.post('/api/annotations/add', body);
}

export function editAnnotation(body: {
  id: string;
  content?: AnnotationContent;
  needs_review?: boolean;
}): Promise<AnnotationsResponse> {
  return api.post('/api/annotations/edit', body);
}

export function removeAnnotation(id: string): Promise<AnnotationsResponse> {
  return api.post('/api/annotations/remove', { id });
}

// --- Claims table (claims ↔ sources, with the passage behind each link) ---

export interface ClaimsFilter {
  topic?: string;
  front?: string;
}

/** GET /api/research/claims?topic=&front= — newest first is the page's job. */
export function getClaims(filter: ClaimsFilter, signal?: AbortSignal): Promise<ClaimsListResponse> {
  const params = new URLSearchParams();
  if (filter.topic) params.set('topic', filter.topic);
  if (filter.front) params.set('front', filter.front);
  const query = params.toString();
  return api.get(`/api/research/claims${query ? `?${query}` : ''}`, signal);
}

/** GET /api/research/claims/<id> — one claim with every source linked to it. */
export function getClaim(id: string, signal?: AbortSignal): Promise<ClaimDetailResponse> {
  return api.get(`/api/research/claims/${encodeURIComponent(id)}`, signal);
}

/** GET /api/research/sources/<id>/claims — every claim citing one source. */
export function getSourceClaims(id: string, signal?: AbortSignal): Promise<SourceClaimsResponse> {
  return api.get(`/api/research/sources/${encodeURIComponent(id)}/claims`, signal);
}

// --- Error message mapping (parity with the old alerts) ---

/**
 * The old page mapped a 404 on the newer endpoints to "the code's in, the
 * process isn't" ("X API not loaded yet — needs an app restart."), network
 * failures to "Network error — try again.", and everything else to the
 * server's error string or a fallback.
 */
export function researchErrorMessage(err: unknown, fallback: string, notLoadedName?: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404 && notLoadedName) {
      return `${notLoadedName} API not loaded yet — needs an app restart.`;
    }
    return err.message || fallback;
  }
  if (err instanceof TypeError) return 'Network error — try again.';
  return fallback;
}
