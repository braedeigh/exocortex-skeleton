/**
 * transcriptRail.ts — the topic rail's rows, counted from what's on the pond.
 *
 * The rail beside the transcript pond lists topics the way the journal pond
 * lists threads: each row says how many DAYS the topic touches and how many
 * messages it holds, and topics that span more days sit higher (a subject you
 * kept coming back to over months outranks one long afternoon).
 *
 * The counts come from the CARDS currently loaded, not from the database
 * totals, so they always agree with what's drawn: narrow the range, search,
 * or hide the chatbot's replies, and the rail recounts to match. A topic with
 * nothing left on the pond drops off the rail rather than showing zero.
 *
 * Pure — no React, no fetching. Used by TranscriptsPond.tsx, tested in
 * transcriptRail.test.ts.
 */
import type { TranscriptCard, TranscriptTopic } from './api';

export interface RailRow {
  key: string;
  name: string;
  tag: string;
  days: number;
  messages: number;
  conversations: { id: number; title: string }[];
}

/** Rows for every topic with at least one message on the pond, widest span first. */
export function railRows(
  topics: readonly TranscriptTopic[],
  cards: readonly TranscriptCard[],
): RailRow[] {
  // Tally days and messages per tag, in one pass over the cards.
  const days = new Map<string, Set<string>>();
  const messages = new Map<string, number>();
  for (const card of cards) {
    for (const tag of card.tags) {
      if (!days.has(tag)) days.set(tag, new Set());
      days.get(tag)!.add(card.day);
      messages.set(tag, (messages.get(tag) ?? 0) + 1);
    }
  }
  return topics
    .filter((t) => messages.has(t.tag))
    .map((t) => ({
      key: `topic:${t.tag}`,
      name: t.name,
      tag: t.tag,
      days: days.get(t.tag)!.size,
      messages: messages.get(t.tag)!,
      conversations: t.conversations,
    }))
    .sort((a, b) => b.days - a.days || b.messages - a.messages || a.name.localeCompare(b.name));
}

/** The messages no topic claims yet — the pile a sort would file. */
export function unsortedCount(cards: readonly TranscriptCard[]): { messages: number; days: number } {
  const hits = cards.filter((c) => c.tags.length === 0);
  return { messages: hits.length, days: new Set(hits.map((c) => c.day)).size };
}

/** A source id as a person would say it. */
export function sourceName(source: string | null | undefined): string {
  if (source === 'chatgpt') return 'ChatGPT';
  if (source === 'claude') return 'Claude';
  return source ?? 'Chatbot';
}

/** Who wrote a card: the user ('B') or the chatbot, named by its source. */
export function speaker(card: { who: string; kind: string | null }): string {
  return card.who === 'B' ? 'You' : sourceName(card.kind);
}
