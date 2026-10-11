import { describe, expect, it } from 'vitest';
import type { TranscriptCard, TranscriptTopic } from './api';
import { railRows, sourceName, speaker, unsortedCount } from './transcriptRail';

const card = (id: string, day: string, tags: string[], who = 'B'): TranscriptCard => ({
  id, day, ts: null, who, kind: 'chatgpt', tags, body: id, conv: 1,
});

const topic = (id: number, name: string): TranscriptTopic => ({
  id, name, tag: `t${id}`, days: 0, first: null, last: null, conversations: [{ id: 1, title: 'x' }],
});

describe('railRows', () => {
  it('ranks a topic that spans more days above one with more messages', () => {
    const cards = [
      card('a', '2026-01-01', ['t1']), card('b', '2026-01-01', ['t1']), card('c', '2026-01-01', ['t1']),
      card('d', '2026-01-01', ['t2']), card('e', '2026-02-01', ['t2']),
    ];
    const rows = railRows([topic(1, 'Busy day'), topic(2, 'Recurring')], cards);
    expect(rows.map((r) => [r.name, r.days, r.messages])).toEqual([
      ['Recurring', 2, 2], ['Busy day', 1, 3],
    ]);
  });

  it('drops a topic with nothing left on the pond', () => {
    expect(railRows([topic(1, 'Gone')], [card('a', '2026-01-01', [])])).toEqual([]);
  });
});

describe('unsortedCount', () => {
  it('counts only messages with no topic', () => {
    const cards = [card('a', '2026-01-01', []), card('b', '2026-01-02', []), card('c', '2026-01-02', ['t1'])];
    expect(unsortedCount(cards)).toEqual({ messages: 2, days: 2 });
  });
});

describe('speaker', () => {
  it('names the user as You and the chatbot by its source', () => {
    expect(speaker({ who: 'B', kind: 'claude' })).toBe('You');
    expect(speaker({ who: 'K', kind: 'claude' })).toBe('Claude');
    expect(sourceName('chatgpt')).toBe('ChatGPT');
  });
});
