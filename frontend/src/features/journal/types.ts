/**
 * types.ts — shapes for the journal API (server.py journal routes,
 * routes/cards.py, routes/entities.py, routes/devnotes.py). Field names
 * match the backend responses exactly; never rename/change a field here
 * without a corresponding backend change.
 */

export interface JournalDay {
  date: string;
  content: string;
  prev: string | null;
  next: string | null;
  error?: string;
}

export type CardWho = 'B' | 'K';

export interface Card {
  id: string;
  who: CardWho;
  /** "YYYY-MM-DD HH:MM:SS" — always sliced as a string, never Date-parsed. */
  ts: string;
  reply_to: string | null;
  tags: string[];
  /** "line" | "context" | "ref" | "" */
  kind: string;
  body: string;
  /**
   * Target strings for a "ref" card (keeper-authored annotation): each is
   * either a journal date "YYYY-MM-DD" or a vault-relative file path (e.g.
   * "people/vivian.md", "THREADS.md"). Always present (default []); only
   * meaningful when kind === "ref". See refTargets.ts for classification.
   */
  refs: string[];
}

export interface CardsResponse {
  date: string;
  editable: boolean;
  cards: Card[];
}

export interface Person {
  id: string;
  name: string;
  file: string;
  tags: string[];
  aliases: string[];
}

export interface PeopleResponse {
  people: Person[];
}

export interface PersonFacts {
  relationship?: string;
  age?: string;
  lives?: string;
  work?: string;
  [key: string]: string | undefined;
}

export interface PersonDetail {
  id: string;
  name: string;
  file: string;
  aliases: string[];
  tags: string[];
  blurb: string;
  facts: PersonFacts;
  entries?: unknown;
}

export interface Mention {
  file: string;
  date: string;
  label: string;
  snippet: string;
}

export interface BacklinksStats {
  first_date: string;
  last_date: string;
  days: number;
  last: string;
}

export interface BacklinksResponse {
  name: string;
  person: PersonDetail | null;
  mentions: Mention[];
  stats: BacklinksStats | null;
}

export interface DevNote {
  id: string;
  text: string;
  created: string;
}

export interface DevNotesResponse {
  tab: string;
  notes: DevNote[];
}

/** GET /api/devnotes/all and /api/ideanotes/all — every tab's notes at once,
 * keyed by tab name. Backs the /notes browser page. */
export interface AllNotesResponse {
  tabs: Record<string, DevNote[]>;
}

/** Combined day fetch (journal blob + cards), what useJournalDay returns. */
export interface JournalDayBundle {
  journal: JournalDay;
  cards: CardsResponse;
}

export type DayMode = 'cards' | 'blob' | 'empty';

/**
 * Decide how a day should render, per the spec:
 *  - card-stream mode: editable && cards.length > 0
 *  - empty post-cutover day: editable && cards.length === 0 && !content
 *  - markdown-blob mode: everything else (pre-cutover, or a cutover day
 *    that somehow has content but no cards)
 */
export function resolveDayMode(bundle: JournalDayBundle): DayMode {
  const { journal, cards } = bundle;
  if (cards.editable && cards.cards.length > 0) return 'cards';
  if (cards.editable && cards.cards.length === 0 && !journal.content.trim()) return 'empty';
  return 'blob';
}
