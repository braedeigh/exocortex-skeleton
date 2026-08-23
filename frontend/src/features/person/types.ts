/**
 * types.ts — shapes for the deep person page API (routes/person.py, built on
 * routes/entities.py's Person/Mention/Day dicts). Field names match the
 * backend responses exactly; never rename/change a field here without a
 * corresponding backend change.
 */

/** One structured "Referenced In" line from the person's own file. */
export interface PersonEntry {
  date: string;
  note: string;
}

/** entities._parse_person() — one people/*.md file, fully parsed. */
export interface PersonDetail {
  id: string;
  name: string;
  file: string;
  blurb: string;
  impression: string;
  body: string;
  entries: PersonEntry[];
  tags: string[];
  aliases: string[];
  facts: Record<string, string>;
}

export interface PersonStatsLast {
  date: string;
  file: string;
  label: string;
  snippet: string;
}

/** entities.person_stats() — the rolled-up summary block. */
export interface PersonStats {
  total: number;
  days: number;
  first_date: string;
  last_date: string;
  last: PersonStatsLast | null;
}

/** entities.mention_days() — one day on the activity timeline. */
export interface MentionDay {
  date: string;
  count: number;
}

/** entities.find_mentions() — a loose hit anywhere else in the vault. */
export interface PersonMention {
  file: string;
  label: string;
  date: string;
  snippet: string;
  count: number;
}

/** GET /api/person/<slug> (routes/person.py person_api). */
export interface PersonResponse {
  person: PersonDetail;
  stats: PersonStats;
  days: MentionDay[];
  mentions: PersonMention[];
  /** people/views/<slug>.md when the rendered card view exists, else null. */
  card_view: string | null;
}

/** POST /api/person/<slug>/facts -> the re-serialized facts map. */
export interface FactsResponse {
  facts: Record<string, string>;
}

/** POST /api/person/<slug>/summarize (routes/person.py person_summarize) —
 * mints or rejoins the person's Reading Room helper session. */
export interface SummarizeResponse {
  ok: boolean;
  conversation_id: string;
  newly_spawned: boolean;
  kind?: string;
}
