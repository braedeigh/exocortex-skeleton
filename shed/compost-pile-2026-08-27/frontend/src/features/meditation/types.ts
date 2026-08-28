/**
 * types.ts — shapes for /api/data/meditation (server.py get_data_meditation)
 * and the two stores behind it: meditation_log.json + deity_profiles.json
 * (routes/meditation.py).
 */

export interface MeditationEntry {
  id: string;
  /** Practice tags — builtin slugs (sitting, walking, …) or custom slugs. */
  types?: string[];
  /** ISO yyyy-mm-dd, or null for "undated". */
  date?: string | null;
  /** Minutes; the backend passes through whatever was posted. */
  duration_min?: number | string | null;
  notes?: string;
}

export interface DeityLink {
  id?: string;
  title?: string;
  url?: string;
  description?: string;
}

export interface DeityProfile {
  id: string;
  name?: string;
  epithet?: string;
  /** Short preview line, derived from the body's "Romanized text:" section. */
  mantra?: string;
  /** Full pasted markdown (headings, tables, quotes, links). */
  body?: string;
  links?: DeityLink[];
}

/** Only the slices of get_data_meditation() this page reads are typed. */
export interface MeditationData {
  server_date?: string;
  meditation_log?: { entries?: MeditationEntry[] };
  deity_profiles?: { profiles?: DeityProfile[] };
  meditation_notes?: { text?: string };
}
