/**
 * types.ts — the shapes routes/recordings.py returns. Mirrors it exactly; when
 * one side changes, change both.
 *
 * The split that matters: a LIST response carries `transcript.preview` (a few
 * hundred characters) and never the full text. The full text arrives only from
 * getRecording() — one fetch, for the one recording being read.
 */

/** A file on the server's recordings shelf. `null` = this recording has none. */
export interface FileRef {
  filename: string;
  bytes: number;
  added_at: string;
  /** What it was called on her phone, kept for recognizability. Audio only. */
  original_name?: string;
  /** Transcript only — cheap counts so a card can say how long it is. */
  chars?: number;
  words?: number;
  lines?: number;
  /** List responses only (see _summarize). */
  preview?: string;
  truncated?: boolean;
}

export interface Recording {
  id: string;
  title: string;
  /** YYYY-MM-DD, or '' for undated (sorts last). */
  date: string;
  kind: string;
  /** Where it came from — 'iPhone Voice Memos', a person, a device. */
  source: string;
  notes: string;
  /** Human string like '2h 14m'. Filled in by the browser at upload time. */
  duration: string;
  tags: string[];
  audio: FileRef | null;
  transcript: FileRef | null;
  created_at?: string;
  last_edited?: string;
  /** Present only on the single-recording fetch. */
  transcript_text?: string;
}

export interface RecordingsResponse {
  items: Recording[];
  kinds: string[];
}

export interface SearchHit {
  id: string;
  title: string;
  date: string;
  kind: string;
  /** Total matches in this transcript; drives the ranking server-side. */
  count: number;
  snippets: string[];
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
}

/** The editable fields, as the add/update endpoints accept them. */
export interface RecordingFields {
  title: string;
  date: string;
  kind: string;
  source: string;
  notes: string;
  duration: string;
  tags: string;
}
