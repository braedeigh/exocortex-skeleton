import { describe, expect, it } from 'vitest';
import { applyEvent, assistantText, turnsFromHistory, userTurn, type Turn } from './events';

const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

const assistant = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('applyEvent', () => {
  it('accumulates deltas into an open assistant turn, then the full message supersedes them', () => {
    const turns: Turn[] = [userTurn('hi', false)];
    applyEvent(turns, delta('Hel'));
    applyEvent(turns, delta('lo.'));
    expect(turns).toHaveLength(2);
    expect(turns[1].open).toBe(true);
    expect(assistantText(turns[1])).toBe('Hello.');
    applyEvent(turns, assistant('Hello.'));
    expect(turns[1].buffer).toBe('');
    expect(assistantText(turns[1])).toBe('Hello.');
    applyEvent(turns, { type: 'result', subtype: 'success' });
    expect(turns[1].open).toBe(false);
  });

  it('keeps the streamed text prefix-stable when a multi-block message folds', () => {
    // Deltas across two text blocks concatenate directly; the authoritative
    // message joins them '\n\n'. Folding the message version would shift
    // every later offset (word-flow spans remount and re-ember). The deltas
    // win while they exist.
    const turns: Turn[] = [];
    applyEvent(turns, delta('block one.'));
    applyEvent(turns, delta('block two.'));
    applyEvent(turns, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'block one.' },
          { type: 'text', text: 'block two.' },
        ],
      },
    });
    expect(assistantText(turns[0])).toBe('block one.block two.');
  });

  it('joins multiple assistant messages in one turn (tool-use rounds) as paragraphs', () => {
    const turns: Turn[] = [];
    applyEvent(turns, assistant('Let me look.'));
    applyEvent(turns, {
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    });
    expect(turns[0].tool).toBe('looking through files…');
    applyEvent(turns, assistant('Found it.'));
    expect(assistantText(turns[0])).toBe('Let me look.\n\nFound it.');
  });

  it("ignores claude's tool-result user echoes but keeps her history user lines", () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'user', text: 'her message' });
    applyEvent(turns, { type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
  });

  it('renders gaps and errors as their own turns', () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'off-record-gap', ts: 'x' });
    applyEvent(turns, { type: 'error', error: 'claude exited 1' });
    expect(turns.map((t) => t.role)).toEqual(['gap', 'error']);
  });
});

describe('journal-mark', () => {
  it('flags the newest assistant turn whose text matches — and only that one', () => {
    const turns: Turn[] = [];
    applyEvent(turns, assistant('same words'));
    applyEvent(turns, { type: 'result', subtype: 'success' });
    applyEvent(turns, { type: 'user', text: 'again?' });
    applyEvent(turns, assistant('same words'));
    applyEvent(turns, { type: 'result', subtype: 'success' });
    applyEvent(turns, { type: 'journal-mark', text: 'same words' });
    // turns: [assistant, user, assistant] — the newest match gets the flag.
    expect(turns[0].journaled).toBe(false);
    expect(turns[2].journaled).toBe(true);
  });

  it('leaves everything untouched when nothing matches', () => {
    const turns: Turn[] = [];
    applyEvent(turns, assistant('a reply'));
    applyEvent(turns, { type: 'journal-mark', text: 'different words' });
    expect(turns[0].journaled).toBe(false);
  });
});

describe('turnsFromHistory', () => {
  it('replays a logged conversation and closes a mid-stream tail', () => {
    const turns = turnsFromHistory([
      { type: 'user', text: 'q1' },
      assistant('a1'),
      { type: 'result' },
      { type: 'user', text: 'q2' },
      delta('half a rep'), // log torn mid-turn (crash) — must not stay open
    ]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[3].open).toBe(false);
    expect(assistantText(turns[3])).toBe('half a rep');
  });
});
