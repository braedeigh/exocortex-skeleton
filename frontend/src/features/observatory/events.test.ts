/**
 * events.test.ts — pins the transcript reducer's core promises: streamed
 * deltas accumulate into an open turn and the authoritative message
 * supersedes them WITHOUT shifting earlier text (offsets into a turn must be
 * prefix-stable, or the word-flow's spans remount mid-read), and the same
 * reducer produces the same turns whether it's fed the live SSE stream or the
 * history jsonl — the one-vocabulary rule that keeps replay and live from
 * drifting.
 */
import { describe, expect, it } from 'vitest';
import { HELPER_SILENT, applyEvent, assistantText, lastUserTurnIndex, questionsState, turnsFromHistory, userTurn, type Turn } from './events';

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

  it('replays an off-record message as hers, dashed — not as a hole', () => {
    // The live send already showed it; a reload used to drop back to a bare
    // gap, so scrolling back she couldn't see what she'd said.
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'user', text: 'a private aside', off_record: true });
    applyEvent(turns, { type: 'user', text: 'and this one counts' });
    expect(turns.map((t) => t.text)).toEqual(['a private aside', 'and this one counts']);
    expect(turns.map((t) => t.offRecord)).toEqual([true, false]);
  });

  it('renders gaps and errors as their own turns', () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'off-record-gap', ts: 'x' });
    applyEvent(turns, { type: 'error', error: 'claude exited 1' });
    expect(turns.map((t) => t.role)).toEqual(['gap', 'error']);
  });

  it('renders a decision turn carrying the command she approved/denied', () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'decision', decision: 'approve', command: 'git commit -m x', ts: 'x' });
    applyEvent(turns, { type: 'decision', decision: 'deny', command: 'rm -rf /', ts: 'x' });
    expect(turns.map((t) => t.role)).toEqual(['decision', 'decision']);
    expect(turns[0].decision).toBe('approve');
    expect(turns[0].text).toBe('git commit -m x');
    expect(turns[1].decision).toBe('deny');
    expect(turns[1].text).toBe('rm -rf /');
  });

  it('defaults a malformed decision to approve rather than dropping it', () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'decision', ts: 'x' }); // no decision/command
    expect(turns[0].role).toBe('decision');
    expect(turns[0].decision).toBe('approve');
    expect(turns[0].text).toBe('');
  });
});

describe('reminder', () => {
  it('is its own System turn carrying who set it, never a user turn', () => {
    const turns: Turn[] = [];
    applyEvent(turns, { type: 'reminder', text: 'Permafest is tomorrow', source: 'keeper', ts: 'x' });
    applyEvent(turns, { type: 'reminder', text: 'Ask about applications', source: 'manual', ts: 'x' });
    expect(turns.map((t) => t.role)).toEqual(['reminder', 'reminder']);
    expect(turns[0].source).toBe('keeper');
    expect(turns[1].source).toBe('manual');
    expect(turns[0].text).toBe('Permafest is tomorrow');
  });
});

describe("a helper's wake-up", () => {
  const wake = { type: 'reminder', text: 'Room change — a is new', source: 'helper-wake', ts: 'x' };
  const shown = (events: unknown[]) =>
    turnsFromHistory(events).filter((t) => !t.silent).map((t) => t.role);

  it('stays out of the chat when the helper has nothing to say, and keeps its place in the array', () => {
    const events = [{ type: 'user', text: 'hi' }, assistant('hello'), { type: 'result' },
      wake, assistant(HELPER_SILENT), { type: 'result' }];
    expect(shown(events)).toEqual(['user', 'assistant']);
    expect(turnsFromHistory(events)).toHaveLength(4);
  });

  it('shows the wake-up and the reply once the helper says something', () => {
    expect(shown([wake, assistant('Two sessions are both in config.py.'), { type: 'result' }]))
      .toEqual(['reminder', 'assistant']);
  });

  it('keeps hiding the closing silence after a message the helper sent an agent', () => {
    const sent = { type: 'peer', direction: 'out', id: 1, to_conv: 'a', text: 'check config.py' };
    expect(shown([wake, sent, assistant(HELPER_SILENT), { type: 'result' }])).toEqual(['peer']);
  });

  it('reveals the reply while it streams, at the first word that is not the silence', () => {
    const delta = (text: string) => ({
      type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    const turns: Turn[] = [];
    applyEvent(turns, wake);
    applyEvent(turns, delta('(nothing'));
    expect(turns.every((t) => t.silent)).toBe(true);
    applyEvent(turns, delta(' new here, but'));
    expect(turns.some((t) => t.silent)).toBe(false);
  });

  it("never hides a reply to her own message, even one that says only the silence", () => {
    expect(shown([{ type: 'user', text: 'anything?' }, assistant(HELPER_SILENT), { type: 'result' }]))
      .toEqual(['user', 'assistant']);
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

describe('lastUserTurnIndex', () => {
  it('finds the last user turn among mixed roles', () => {
    const turns = turnsFromHistory([
      { type: 'user', text: 'q1' },
      assistant('a1'),
      { type: 'result' },
      { type: 'user', text: 'q2' },
      assistant('a2'),
      { type: 'result' },
    ]);
    expect(lastUserTurnIndex(turns)).toBe(2);
  });

  it('returns -1 when there are no user turns', () => {
    const turns = turnsFromHistory([assistant('a1'), { type: 'result' }]);
    expect(lastUserTurnIndex(turns)).toBe(-1);
  });

  it('returns -1 for an empty conversation', () => {
    expect(lastUserTurnIndex([])).toBe(-1);
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

describe('peer', () => {
  const out = {
    type: 'peer',
    direction: 'out',
    id: 7,
    from_conv: 'a',
    from_title: 'Terrain',
    to_conv: 'b',
    to_title: 'Pond',
    text: 'store.py changed',
    mode: 'inject',
    status: 'held',
    held_reason: 'too many steps',
  };

  it('draws a sent message as a card addressed to the recipient', () => {
    const [t] = turnsFromHistory([out]);
    expect(t.role).toBe('peer');
    expect(t.text).toBe('store.py changed');
    expect(t.peer).toMatchObject({ direction: 'out', otherConv: 'b', otherTitle: 'Pond', status: 'held' });
  });

  it('shows a received message as from the sender, and delivered', () => {
    const [t] = turnsFromHistory([{ ...out, direction: 'in', status: 'waiting' }]);
    expect(t.peer).toMatchObject({ direction: 'in', otherConv: 'a', otherTitle: 'Terrain', status: 'delivered' });
  });

  it('releasing a held message updates its card', () => {
    const [t] = turnsFromHistory([out, { type: 'peer-status', id: 7, status: 'waiting' }]);
    expect(t.peer?.status).toBe('waiting');
    expect(t.peer?.heldReason).toBe('');
  });
});

describe('questions', () => {
  // The chat keeps every set the agent filed, where it filed it: open until
  // she replies, answered after, replaced when a newer set followed it.
  it('keeps each filed set in place above her answer, live and on reload alike', () => {
    const log = [
      { type: 'user', text: 'build it' },
      delta('Looking…'),
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } },
      { type: 'questions', questions: ['Sqlite or postgres?', '  '] },
      { type: 'questions', questions: ['Only: sqlite?'] },
      delta('Filed.'),
      { type: 'result', subtype: 'success' },
    ];
    const live: Turn[] = [];
    for (const e of log) applyEvent(live, e);
    const turns = turnsFromHistory(log);
    expect(live.map((t) => t.role)).toEqual(turns.map((t) => t.role));
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'questions', 'questions', 'assistant']);
    // the reply the block interrupted is closed, not left "running a command…"
    expect(live[1]).toMatchObject({ open: false, tool: null });
    expect(live[4].open).toBe(false);
    expect(turns[2].questions).toEqual(['Sqlite or postgres?']);
    expect([questionsState(turns, 2), questionsState(turns, 3)]).toEqual(['replaced', 'open']);
    turns.push(userTurn('sqlite', false));
    expect(questionsState(turns, 3)).toBe('answered');
  });
});
