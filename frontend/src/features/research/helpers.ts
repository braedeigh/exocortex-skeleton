/**
 * helpers.ts — pure derivations over the research pool, ported one-for-one
 * from static/js/research.js (topic ordering, question lifecycle, thread
 * structure, context chains, doc-id resolution). No I/O, no DOM.
 */

import type { ContextItem, EdgeFile, Entry, Session, Topic } from './types';

export const RSRCH_KINDS: [string, string][] = [
  ['note', 'Note'],
  ['source', 'Source'],
  ['claim', 'Claim'],
  ['question', 'Question'],
];

export const KIND_LABEL: Record<string, string> = {
  note: 'Note',
  source: 'Source',
  claim: 'Claim',
  question: 'Question',
};

/** Claim verdict tap-cycle: '' -> real -> shaky -> interesting -> '' */
export const CLAIM_CYCLE: Record<string, string> = {
  '': 'real',
  real: 'shaky',
  shaky: 'interesting',
  interesting: '',
};

/** Topic status tap-cycle in the thread editor. */
export const NEXT_TOPIC_STATUS: Record<string, string> = {
  active: 'dormant',
  dormant: 'settled',
  settled: 'active',
};

const STATUS_RANK: Record<string, number> = { active: 0, dormant: 1, settled: 2 };

export function topicsById(topics: Topic[]): Record<string, Topic> {
  return Object.fromEntries(topics.map((t) => [t.id, t]));
}

/** Topics ordered by status rank (active, dormant, settled) then by the
 * created stamp of their most recent entry, newest first. */
export function orderedTopics(topics: Topic[], entries: Entry[]): Topic[] {
  const latest: Record<string, string> = {};
  for (const e of entries) {
    for (const tid of e.topics ?? []) {
      if (!latest[tid] || (e.created ?? '') > latest[tid]) latest[tid] = e.created ?? '';
    }
  }
  return topics.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 3;
    const rb = STATUS_RANK[b.status] ?? 3;
    if (ra !== rb) return ra - rb;
    return (latest[b.id] ?? '').localeCompare(latest[a.id] ?? '');
  });
}

// --- Question lifecycle ---

export type AnswerState = 'waiting' | 'fresh' | 'settled';

/** Where one of her questions sits: 'waiting' (no claude answer yet),
 * 'fresh' (claude answered, at least one answer unreviewed), 'settled'
 * (every answer reviewed, or she closed it herself). */
export function answerState(e: Entry, entries: Entry[]): AnswerState {
  const answers = entries.filter((r) => r.author === 'llm' && r.reply_to === e.id);
  if (answers.length) return answers.some((r) => !r.reviewed) ? 'fresh' : 'settled';
  return e.status === 'answered' ? 'settled' : 'waiting';
}

export type Tint = 'pink' | 'orange' | 'purple' | 'flagged' | null;

/** Row tint for an entry: llm answers orange until reviewed then purple; her
 * questions pink while waiting then purple; other entries purple once
 * processed, accent edge while flagged. At most one applies. */
export function entryTint(e: Entry, entries: Entry[]): Tint {
  if (e.author === 'llm') return e.reviewed ? 'purple' : 'orange';
  if (e.kind === 'question') return answerState(e, entries) === 'waiting' ? 'pink' : 'purple';
  if (e.processed) return 'purple';
  if (e.flagged) return 'flagged';
  return null;
}

/** Questions are never orange: pink while waiting, purple once answered. */
export function questionTint(e: Entry, entries: Entry[]): 'pink' | 'purple' {
  return answerState(e, entries) === 'waiting' ? 'pink' : 'purple';
}

export function openQuestions(entries: Entry[]): Entry[] {
  return entries
    .filter((e) => e.kind === 'question' && e.status === 'open')
    .slice()
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

// --- Queue / send ---

/** Entries she has queued for Claude (llm outputs can't be flagged). */
export function flaggedQueue(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.flagged && e.author !== 'llm');
}

export function unreviewedCount(entries: Entry[]): number {
  return entries.filter((e) => e.author === 'llm' && !e.reviewed).length;
}

export function unfiledEntries(entries: Entry[]): Entry[] {
  return entries
    .filter((e) => !(e.topics && e.topics.length))
    .slice()
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

// --- Sessions ---

/** "In flight" = running or queued (waiting on the dispatcher). */
export function anySessionInFlight(sessions: Session[]): boolean {
  return sessions.some((s) => s.status === 'running' || s.status === 'queued');
}

/** The running/queued deep session for a question, if any. */
export function activeDeepSession(sessions: Session[], entryId: string): Session | null {
  return (
    sessions.find(
      (s) =>
        s.mode === 'deep' &&
        (s.status === 'running' || s.status === 'queued') &&
        (s.entry_ids ?? []).includes(entryId),
    ) ?? null
  );
}

/** The running/queued distill session for a topic, if any. */
export function activeDistillSession(sessions: Session[], topicId: string): Session | null {
  return (
    sessions.find(
      (s) =>
        s.mode === 'distill' &&
        (s.status === 'running' || s.status === 'queued') &&
        (s.topics ?? []).includes(topicId),
    ) ?? null
  );
}

export function sessionsForTopic(sessions: Session[], topicId: string): Session[] {
  return sessions
    .filter((s) => (s.topics ?? []).includes(topicId))
    .slice()
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

// --- Thread view structure ---

export interface ThreadStats {
  count: number;
  flagged: number;
  unreviewed: number;
  open: number;
}

export function topicStats(topicId: string, entries: Entry[]): ThreadStats {
  const own = entries.filter((e) => (e.topics ?? []).includes(topicId));
  return {
    count: own.length,
    flagged: own.filter((e) => e.flagged && e.author !== 'llm').length,
    unreviewed: own.filter((e) => e.author === 'llm' && !e.reviewed).length,
    open: own.filter((e) => e.kind === 'question' && e.status === 'open').length,
  };
}

export interface ThreadStructure {
  /** all of the thread's entries, newest first */
  entries: Entry[];
  /** entries with no in-thread parent, newest first */
  topLevel: Entry[];
  /** replies under a parent, oldest first (a chain reads top-to-bottom) */
  repliesOf: Record<string, Entry[]>;
}

/** Top-level entries sort newest-first (posting lands at the top); replies
 * under a given parent stay chronological. A reply whose parent is outside
 * the thread renders as top-level. */
export function threadStructure(entries: Entry[], topicId: string): ThreadStructure {
  const own = entries
    .filter((e) => (e.topics ?? []).includes(topicId))
    .slice()
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  const idsInThread = new Set(own.map((e) => e.id));
  const repliesOf: Record<string, Entry[]> = {};
  for (const e of own) {
    if (e.reply_to && idsInThread.has(e.reply_to)) {
      (repliesOf[e.reply_to] = repliesOf[e.reply_to] ?? []).push(e);
    }
  }
  for (const kids of Object.values(repliesOf)) {
    kids.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
  }
  const topLevel = own.filter((e) => !e.reply_to || !idsInThread.has(e.reply_to));
  return { entries: own, topLevel, repliesOf };
}

// --- Context chain (composer follow-ups + annotation research) ---

/** Walk the reply chain from noteId up to the root: [{id, kind, snippet,
 * file, checked}], starting with the note itself. Guards against cycles and
 * missing entries. */
export function contextChain(entries: Entry[], noteId: string): ContextItem[] {
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const chain: ContextItem[] = [];
  const seen = new Set<string>();
  let cur: Entry | undefined = byId[noteId];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push({
      id: cur.id,
      kind: cur.kind || 'note',
      snippet: (cur.text ?? '').slice(0, 90),
      file: cur.file ?? null,
      checked: true,
    });
    cur = cur.reply_to ? byId[cur.reply_to] : undefined;
  }
  return chain;
}

// --- Annotator doc ids ---

/** Resolve the owning research entry id from an annotator doc id:
 * entry:<id> -> that id; note:<file> -> the entry whose .file matches. */
export function resolveDocOwner(doc: string, entries: Entry[]): string | null {
  if (doc.startsWith('entry:')) return doc.slice('entry:'.length);
  if (doc.startsWith('note:')) {
    const fname = doc.slice('note:'.length);
    const owner = entries.find((e) => e.file === fname);
    return owner ? owner.id : null;
  }
  return null;
}

/** Sources with fetched full text, in docTexts order: the Articles card. */
export function articlesWithText(entries: Entry[], docTexts: Set<string>): { doc: string; entry: Entry }[] {
  const byDoc: Record<string, Entry> = {};
  for (const e of entries) {
    if (e.kind === 'source') byDoc[`entry:${e.id}`] = e;
  }
  return Array.from(docTexts)
    .filter((d) => byDoc[d])
    .map((d) => ({ doc: d, entry: byDoc[d] }));
}

// --- Library / edge notes ---

/** The one topic's edge-of-knowledge note, if the distiller ever wrote one. */
export function edgeFor(edge: EdgeFile[], topicId: string): EdgeFile | null {
  return edge.find((f) => f.file === `edge/${topicId}.md`) ?? null;
}

/** Reviewed llm answers in this topic newer than the edge note's mtime —
 * the "N reviewed since" re-distill nudge. */
export function reviewedSince(entries: Entry[], topicId: string, edgeMtime: string): number {
  return entries.filter(
    (e) =>
      e.author === 'llm' &&
      !!e.reviewed &&
      (e.topics ?? []).includes(topicId) &&
      (e.created ?? '').slice(0, 10) > (edgeMtime || ''),
  ).length;
}

// --- Misc formatting ---

/** 'Given Family', 'A & B', or 'A et al.' */
export function authorsShort(authors?: { given?: string; family?: string }[]): string {
  if (!authors || !authors.length) return '';
  const name = (a: { given?: string; family?: string }) => [a.given, a.family].filter(Boolean).join(' ');
  if (authors.length === 1) return name(authors[0]);
  if (authors.length === 2) return `${name(authors[0])} & ${name(authors[1])}`;
  return `${name(authors[0])} et al.`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** '1 entry' / '3 entries' pluralizer used all over the old page. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** 'note:<file>' origin -> the file path, else ''. */
export function originFile(e: Entry): string {
  return (e.origin ?? '').startsWith('note:') ? (e.origin as string).slice(5) : '';
}
