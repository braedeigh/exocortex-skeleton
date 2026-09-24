/**
 * types.ts — shapes for the research workspace, mirroring routes/research.py's
 * research.json schema, routes/annotations.py's annotation model, and the
 * library/search/texts endpoints. All the "newer" fields are optional — old
 * entries simply lack them (see routes/research.py's module docstring).
 */

export type { Front } from '../fronts/useFronts';

export type EntryKind = 'note' | 'source' | 'claim' | 'question';

/** Synthetic thread id for the Uncategorized pseudo-thread — entries with no
 * topics, surfaced as a thread-shaped view instead of a separate card. */
export const UNFILED_ID = '__unfiled__';

export interface Topic {
  id: string;
  name: string;
  /** 'active' | 'dormant' | 'settled' */
  status: string;
  created?: string;
  /** front ids (see routes/fronts.py) tagging this topic to a life domain */
  fronts?: string[];
}

/** Crossref-derived source metadata (routes/research_sources.py annotate). */
export interface SourceMeta {
  kind?: string;
  source?: string;
  reviewed?: boolean;
  doi?: string;
  title?: string;
  authors?: { given?: string; family?: string }[];
  journal?: string;
  published?: string;
  abstract?: string;
  cited_by?: number | null;
  pdf_url?: string | null;
  fetched?: string;
}

export interface Entry {
  id: string;
  kind: string;
  text: string;
  topics?: string[];
  url?: string;
  /** claim: '' | 'real' | 'shaky' | 'interesting'; source: '' | 'verified' */
  verdict?: string;
  /** question: 'open' | 'answered'; other kinds: '' */
  status?: string;
  reply_to?: string | null;
  created?: string;
  /** queued to send to Claude */
  flagged?: boolean;
  /** a runner session has dealt with this entry */
  processed?: boolean;
  /** 'llm' marks a runner-written reply; absent means hers */
  author?: string;
  /** llm entries only: has she signed off on it */
  reviewed?: boolean;
  /** id of the session that produced an llm entry */
  session?: string;
  /** deep-research replies: the report file in the library (research/<file>) */
  file?: string;
  /** e.g. 'note:<file>' for imported questions */
  origin?: string;
  re_quote?: string;
  context_ids?: string[];
  meta?: SourceMeta | null;
}

export interface Session {
  id: string;
  entry_ids?: string[];
  topics?: string[];
  created?: string;
  /** 'queued' | 'running' | 'done' | 'failed' */
  status?: string;
  report?: string;
  /** undefined = regular runner; 'deep' | 'distill' | 'regular' */
  mode?: string;
  worker?: boolean;
  /** total tokens for this run (input+cache_creation+cache_read+output),
   * stamped at close if a claude_session was captured — see
   * scripts/claude_transcripts.py's session_receipt */
  tokens?: number;
  /** wall-clock seconds from `created` to close */
  duration_sec?: number;
}

export interface ResearchState {
  topics: Topic[];
  entries: Entry[];
  sessions: Session[];
}

/** Every research CRUD endpoint returns the full state blob. */
export interface ResearchBlob extends ResearchState {
  ok?: boolean;
  /** entry/add also returns the new entry's id */
  id?: string;
  session?: Session;
}

/** GET /api/research/health — worker-slot snapshot for the heartbeat pill. */
export interface ResearchHealth {
  available_mb: number | null;
  floor_mb: number;
  per_worker_mb: number;
  max_concurrent: number;
  live_workers: number;
  slots: number;
}

export interface LibraryFile {
  path: string;
  name?: string;
  title: string;
  mtime: string;
  size?: number;
}

/** Distiller "edge of knowledge" notes, pinned per topic thread. */
export interface EdgeFile {
  file: string; // 'edge/<topic-id>.md'
  title: string;
  mtime: string;
}

export interface LibraryResponse {
  files: LibraryFile[];
  edge: EdgeFile[];
}

export interface LibraryFileResponse {
  path: string;
  title: string;
  text: string;
}

export interface SearchHit {
  id: string;
  /** 'note' (library file) | 'entry' */
  kind: string;
  title?: string;
  snippet?: string;
  score?: number;
  entry_kind?: string;
  /** topic NAMES (not ids) for entry hits */
  topics?: string[];
}

// --- Annotations (routes/annotations.py over docstore/textanchor) ---

export interface Selector {
  exact: string;
  char_start: number;
  char_end: number;
}

export interface AnnotationContent {
  kind?: string;
  note?: string;
  /** 'llm' | 'human' */
  source?: string;
  [key: string]: unknown;
}

export type AnnotationState = 'verified' | 'relocated' | 'lost' | 'unresolved';

export interface Annotation {
  id: string;
  doc: string;
  content?: AnnotationContent;
  needs_review?: boolean;
  selector?: Selector | null;
  created?: string;
  /** recomputed server-side against the live doc text on every GET */
  state?: AnnotationState;
}

export interface AnnotationsResponse {
  doc: string;
  annotations: Annotation[];
}

export interface DocTextResponse {
  doc: string;
  title: string;
  text: string;
}

// --- Claims table (GET /api/research/claims, /claims/<id>, /sources/<id>/claims) ---

/** '' = not judged yet; the same tap-cycle vocabulary as a claim entry. */
export type ClaimVerdict = '' | 'real' | 'shaky' | 'interesting';

/** The measured thing a claim asserts, when it has one: "subject measure =
 * amount unit (basis, year)", plus the evidence tier the session assigned. */
export interface ClaimValue {
  subject: string;
  measure: string;
  amount: number | null;
  unit: string;
  basis: string;
  year: number | null;
  tier: string;
}

export interface Claim {
  id: string;
  text: string;
  verdict: ClaimVerdict;
  /** topic ids */
  topics: string[];
  /** front ids */
  fronts: string[];
  created: string;
  /** 'owner' | 'llm' | a session/agent name */
  author: string;
  reviewed: boolean;
  source_count: number;
  value: ClaimValue | null;
}

/** How a source bears on the claim it is linked to. */
export type SourceStance = 'supports' | 'contradicts' | 'context';

/** The passage in the source's text that backs the link — the same shape as
 * an Annotation's selector, flattened, so the claims page can open the doc
 * scrolled to it. */
export interface ClaimSourceAnnotation {
  id: string;
  doc: string;
  char_start: number;
  char_end: number;
  exact: string;
  note: string;
}

export interface ClaimSource {
  id: string;
  text: string;
  url: string;
  verdict: string;
  stance: SourceStance;
  note: string;
  annotation: ClaimSourceAnnotation | null;
  /** annotation doc id, e.g. "entry:<id>" */
  doc: string;
  /** the doc has extracted text to read (GET /api/annotations/doc-text) */
  has_text: boolean;
}

export interface ClaimsListResponse {
  claims: Claim[];
}

export interface ClaimDetailResponse {
  claim: Claim;
  sources: ClaimSource[];
  value: ClaimValue | null;
}

export interface SourceClaimsResponse {
  source: { id: string; text: string; url: string };
  claims: Claim[];
}

// --- Composer (page-local state, matches the old _rsrchComposer) ---

export interface ContextItem {
  id: string;
  kind: string;
  snippet: string;
  file: string | null;
  checked: boolean;
}

export interface ComposerState {
  text: string;
  kind: EntryKind;
  url: string;
  topics: Set<string>;
  replyTo: { id: string; text: string } | null;
  reQuote: string | null;
  contextChain: ContextItem[] | null;
}

export function emptyComposer(): ComposerState {
  return { text: '', kind: 'note', url: '', topics: new Set(), replyTo: null, reQuote: null, contextChain: null };
}

export function emptyResearch(): ResearchState {
  return { topics: [], entries: [], sessions: [] };
}
