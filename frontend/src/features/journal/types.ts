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
  reply_to?: string | null;
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
  /**
   * Day-view-only enrichment (routes/cards.py get_cards) for a card that
   * carries a `reply_to`: the parent card's date + a truncated (~12-word)
   * snippet of its body. Absent when the card has no reply_to; null when the
   * parent card no longer exists on disk. Not present on add/update
   * responses — only the day GET enriches.
   */
  reply_context?: { id: string; date: string; snippet: string } | null;
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

/**
 * GET /api/threads roster entry (routes/threads.py threads_list).
 * `fronts`/`parents`/`kind`/`status` are the threads-architecture.md §3 DAG
 * fields — all optional/empty-array-safe because the live vault's threads
 * predate the migration (§9) and carry none of them yet: every node is
 * currently a parentless root with no fronts and no kind. First element of
 * `fronts`/`parents` is primary (ownership / breadcrumb respectively).
 */
export interface Thread {
  id: string;
  name: string;
  file: string;
  aliases: string[];
  /** Life-domain tags (front ids from data/fronts.json); missing/[] if untagged. */
  fronts?: string[];
  /** Parent thread slugs — 0+, DAG not tree; missing/[] means it's a root. */
  parents?: string[];
  /** "standing" | "arc" | null/undefined (unset on un-migrated threads). */
  kind?: string | null;
  /** "" | "seedling" | "active" | "dormant" | "retired" | undefined. */
  status?: string;
  /** The thread's cast — `people:` slugs resolved to display names
   * (routes/threads.py `_resolve_cast`); missing/[] if it names no one. */
  people?: ThreadCastMember[];
}

/** One cast member on a thread — `people:` slug resolved to a display name
 * (routes/threads.py `_resolve_cast`): the person file's H1 if it resolves,
 * else a title-cased fallback of the slug. */
export interface ThreadCastMember {
  slug: string;
  name: string;
}

export interface ThreadsResponse {
  threads: Thread[];
}

/** One node in GET /api/threads/tree's `nodes` map (routes/threads.py
 * threads_tree) — same membership/lifecycle fields as `Thread` plus the
 * derived `children` edge list; no `id`/`file`/`aliases` (keyed by slug in
 * the parent map instead). `people` here is the raw cast slug list (cheap —
 * the tree view is structural; name resolution happens on the roster/detail
 * endpoints only). */
export interface ThreadTreeNode {
  name: string;
  fronts: string[];
  parents: string[];
  people: string[];
  kind: string | null;
  status: string;
  children: string[];
}

/** GET /api/threads/tree — the derived parent/child DAG (threads-architecture.md
 * §7), rebuilt fresh from `parents:` edges on every request, never stored. */
export interface ThreadsTreeResponse {
  roots: string[];
  nodes: Record<string, ThreadTreeNode>;
}

/**
 * One routable source chip on a thread fact-card (routes/threads.py
 * _classify_source): kind "journal" navigates in-app to `val` (a
 * YYYY-MM-DD date), kind "keeper" opens the Files tab on `val` (a
 * vault-relative path).
 */
export interface ThreadSource {
  ref: string;
  kind: 'journal' | 'keeper';
  val: string;
  label: string;
}

/** One fact-card: a short statement + the sources it came from. */
export interface ThreadFactCard {
  heading: string;
  text: string;
  sources: ThreadSource[];
}

/** GET /api/thread?name=<slug|name|alias> (routes/threads.py thread_detail).
 * `status` is always present here (parse_thread defaults it to "" — unlike
 * the optional `Thread.status`, which some construction sites omit). */
export interface ThreadDetail extends Thread {
  status: string;
  cards: ThreadFactCard[];
  /** {slug: resolved} for each entry in `people` — whether /person/<slug>
   * would actually resolve (entities.resolve_person), a sibling map rather
   * than a field folded into each cast entry so it can't disturb the
   * `{slug, name}` shape other callers of `people` already assert on. Used
   * by the wiki's per-thread page to render an unresolved cast member as a
   * muted redlink (WikiHome's same redlink convention for people). */
  peopleResolved?: Record<string, boolean>;
}

/** One journal-pool card in a thread's journal stream (routes/threads.py
 * thread_journal). Distinct from `Card` (the day-editor's shape) — this is
 * read-only, id-scoped, and always carries its own date/who/text. */
export interface ThreadJournalCardEntry {
  kind: 'card';
  id: string;
  /** "YYYY-MM-DD" — the id's date prefix. */
  date: string;
  /** "YYYY-MM-DD HH:MM:SS" — sliced as a string, never Date-parsed. */
  ts: string;
  who: CardWho;
  text: string;
  /** The parent card's id, or null — a card whose reply_to matches another
   * CARD entry's id in this same journal stream renders as that entry's
   * margin note (routes/threads.py thread_journal / ThreadJournalPage). */
  reply_to: string | null;
  /** True iff this card's ts is within the rolling last 24 hours (server-
   * computed, routes/threads.py `_card_editable` — never the client's Date).
   * Editable cards get in-place edit/delete; older ones only get "+ note". */
  editable: boolean;
}

/** A bare-day citation (predates the card pool, or a `` `YYYY-MM-DD` `` source
 * with no specific card) — a placeholder row pointing at that whole day. */
export interface ThreadJournalDayEntry {
  kind: 'day';
  date: string;
  /** The citing fact-card's heading; "" if it had none. */
  label: string;
  /**
   * Bounded mention-windowed excerpts pulled from that day's pre-card-pool
   * markdown blob (routes/threads.py thread_journal / _mention_excerpts) —
   * only populated when the date has no pool card at all; [] when it has
   * pool cards, the blob file is missing/empty, or it doesn't mention the
   * thread. Each string already carries its own leading/trailing "…" where
   * it was clipped.
   */
  excerpts: string[];
}

export type ThreadJournalEntry = ThreadJournalCardEntry | ThreadJournalDayEntry;

/** GET /api/thread/<slug>/journal (routes/threads.py thread_journal) — the
 * thread's whole journal stream (tagged ∪ cited, deduped, ascending). */
export interface ThreadJournalResponse {
  thread: {
    id: string;
    name: string;
    status: string;
    kind: string | null;
    fronts: string[];
    /** Name/alias terms this thread's own mentions are found by — both the
     * server's mention-matching (routes/threads.py thread_journal) and the
     * client's self-mention highlighting (ThreadJournalPage). */
    aliases: string[];
    people: ThreadCastMember[];
  };
  entries: ThreadJournalEntry[];
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
