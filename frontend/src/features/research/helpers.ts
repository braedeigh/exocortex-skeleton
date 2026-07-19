/**
 * helpers.ts — pure derivations over the research pool, ported one-for-one
 * from static/js/research.js (topic ordering, question lifecycle, thread
 * structure, context chains, doc-id resolution). No I/O, no DOM.
 */

import { FRONT_EMOJI, type Front } from '../fronts/useFronts';
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

export type ThreadSortMode = 'recent' | 'name' | 'attention';

/** Threads directory sort — 'recent' is just orderedTopics (status rank then
 * latest activity); 'name' is a plain A-Z; 'attention' surfaces threads that
 * want her eyes first (unreviewed llm answers, then open questions), falling
 * back to recent order for ties. */
export function sortTopics(topics: Topic[], entries: Entry[], mode: ThreadSortMode): Topic[] {
  if (mode === 'name') {
    return topics.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  if (mode === 'attention') {
    const recent = orderedTopics(topics, entries);
    const recentRank: Record<string, number> = {};
    recent.forEach((t, i) => {
      recentRank[t.id] = i;
    });
    return topics.slice().sort((a, b) => {
      const sa = topicStats(a.id, entries);
      const sb = topicStats(b.id, entries);
      if (sa.unreviewed !== sb.unreviewed) return sb.unreviewed - sa.unreviewed;
      if (sa.open !== sb.open) return sb.open - sa.open;
      return recentRank[a.id] - recentRank[b.id];
    });
  }
  return orderedTopics(topics, entries);
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

/** Shared body: given an already-filtered, newest-first-sorted set of a
 * thread's own entries, nest replies under their in-thread parent. A reply
 * whose parent is outside the thread renders as top-level. */
function structureFromOwn(own: Entry[]): ThreadStructure {
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

/** Top-level entries sort newest-first (posting lands at the top); replies
 * under a given parent stay chronological. A reply whose parent is outside
 * the thread renders as top-level. */
export function threadStructure(entries: Entry[], topicId: string): ThreadStructure {
  const own = entries
    .filter((e) => (e.topics ?? []).includes(topicId))
    .slice()
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  return structureFromOwn(own);
}

/** Same nesting logic as threadStructure, over the topicless pool instead of
 * one topic's entries — backs the Uncategorized pseudo-thread. */
export function unfiledStructure(entries: Entry[]): ThreadStructure {
  return structureFromOwn(unfiledEntries(entries));
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

/** Rounded order-of-magnitude token count for the session receipt — "~12k",
 * never a raw comma-grouped number (SessionsCard prepends the "~"). Under
 * 1000 renders as-is; under 1,000,000 rounds to the nearest k (floored at
 * 1k so a small-but-nonzero count doesn't read as "~0k"); above that, one
 * decimal of M. */
export function roundMagnitude(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return `${Math.round(n)}`;
  if (abs < 1_000_000) return `${Math.max(Math.round(n / 1000), 1)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Session-run duration from seconds -> "2m40s" / "1h05m" / "45s". Distinct
 * from todoHelpers' fmtDuration (minutes in, no seconds, a different
 * feature's unit) — a research run's receipt wants second-level
 * granularity since most runs are well under an hour. */
export function fmtRunDuration(sec: number | null | undefined): string {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** '1 entry' / '3 entries' pluralizer used all over the old page. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** 'note:<file>' origin -> the file path, else ''. */
export function originFile(e: Entry): string {
  return (e.origin ?? '').startsWith('note:') ? (e.origin as string).slice(5) : '';
}

/** Where a freshly-added entry landed, for the "Caught — …" toast: one
 * topic -> "{frontEmoji} {topicName}" (emoji omitted if the topic has no
 * front, or that front isn't in the known list); 2+ topics -> "{first} + N
 * more"; no topics -> "waiting in Unfiled". */
export function landingLabel(topicIds: string[], byId: Record<string, Topic>, fronts?: Front[]): string {
  if (!topicIds.length) return 'waiting in Unfiled';
  const first = byId[topicIds[0]];
  const name = first ? first.name : topicIds[0];
  if (topicIds.length > 1) return `${name} + ${topicIds.length - 1} more`;
  const frontId = first?.fronts?.[0];
  const knownFront = !!frontId && (!fronts || fronts.some((f) => f.id === frontId));
  const emoji = knownFront ? FRONT_EMOJI[frontId as string] : undefined;
  return emoji ? `${emoji} ${name}` : name;
}
