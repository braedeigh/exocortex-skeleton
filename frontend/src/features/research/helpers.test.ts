import { describe, expect, it } from 'vitest';
import {
  answerState,
  anySessionInFlight,
  activeDeepSession,
  activeDistillSession,
  articlesWithText,
  authorsShort,
  contextChain,
  edgeFor,
  entryTint,
  flaggedQueue,
  fmtRunDuration,
  landingLabel,
  openQuestions,
  orderedTopics,
  originFile,
  resolveDocOwner,
  reviewedSince,
  roundMagnitude,
  sortTopics,
  threadStructure,
  topicStats,
  unfiledEntries,
  unreviewedCount,
} from './helpers';
import type { Entry, Session, Topic } from './types';
import type { Front } from '../fronts/useFronts';

function entry(partial: Partial<Entry> & { id: string }): Entry {
  return { kind: 'note', text: partial.id, ...partial };
}

describe('orderedTopics', () => {
  it('ranks active < dormant < settled, then most recent entry first', () => {
    const topics: Topic[] = [
      { id: 'settled', name: 'S', status: 'settled' },
      { id: 'quiet-active', name: 'QA', status: 'active' },
      { id: 'busy-active', name: 'BA', status: 'active' },
      { id: 'dormant', name: 'D', status: 'dormant' },
    ];
    const entries: Entry[] = [
      entry({ id: 'a', topics: ['quiet-active'], created: '2026-01-01 10:00' }),
      entry({ id: 'b', topics: ['busy-active'], created: '2026-06-01 10:00' }),
      entry({ id: 'c', topics: ['settled'], created: '2026-07-01 10:00' }),
    ];
    expect(orderedTopics(topics, entries).map((t) => t.id)).toEqual([
      'busy-active',
      'quiet-active',
      'dormant',
      'settled',
    ]);
  });

  it('puts unknown statuses last and does not mutate the input', () => {
    const topics: Topic[] = [
      { id: 'weird', name: 'W', status: '???' },
      { id: 'active', name: 'A', status: 'active' },
    ];
    const before = topics.map((t) => t.id);
    expect(orderedTopics(topics, []).map((t) => t.id)).toEqual(['active', 'weird']);
    expect(topics.map((t) => t.id)).toEqual(before);
  });
});

describe('sortTopics', () => {
  const topics: Topic[] = [
    { id: 'zeta', name: 'Zeta thread', status: 'active' },
    { id: 'alpha', name: 'alpha thread', status: 'active' },
    { id: 'mid', name: 'Mid thread', status: 'active' },
  ];
  const entries: Entry[] = [
    entry({ id: 'e-zeta', topics: ['zeta'], created: '2026-06-01 10:00' }),
    entry({ id: 'e-alpha', topics: ['alpha'], created: '2026-01-01 10:00' }),
    entry({ id: 'e-mid', topics: ['mid'], created: '2026-03-01 10:00' }),
    entry({ id: 'e-mid-llm', topics: ['mid'], author: 'llm', reviewed: false, created: '2026-03-02 10:00' }),
  ];

  it("'recent' matches orderedTopics (latest activity first)", () => {
    expect(sortTopics(topics, entries, 'recent').map((t) => t.id)).toEqual(
      orderedTopics(topics, entries).map((t) => t.id),
    );
    expect(sortTopics(topics, entries, 'recent').map((t) => t.id)).toEqual(['zeta', 'mid', 'alpha']);
  });

  it("'name' sorts case-insensitively A-Z", () => {
    expect(sortTopics(topics, entries, 'name').map((t) => t.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it("'attention' surfaces unreviewed llm answers first, then falls back to recent order", () => {
    expect(sortTopics(topics, entries, 'attention').map((t) => t.id)).toEqual(['mid', 'zeta', 'alpha']);
  });

  it('does not mutate the input topics array', () => {
    const before = topics.map((t) => t.id);
    sortTopics(topics, entries, 'name');
    expect(topics.map((t) => t.id)).toEqual(before);
  });
});

describe('answerState / entryTint (question lifecycle)', () => {
  const q = entry({ id: 'q1', kind: 'question', status: 'open' });

  it('is waiting (pink) with no llm answer', () => {
    expect(answerState(q, [q])).toBe('waiting');
    expect(entryTint(q, [q])).toBe('pink');
  });

  it('is fresh with an unreviewed llm answer, settled once every answer is reviewed', () => {
    const fresh = entry({ id: 'a1', author: 'llm', reply_to: 'q1', reviewed: false });
    expect(answerState(q, [q, fresh])).toBe('fresh');
    const reviewed = { ...fresh, reviewed: true };
    expect(answerState(q, [q, reviewed])).toBe('settled');
  });

  it('is settled when she closed it herself with no answers', () => {
    const closed = entry({ id: 'q2', kind: 'question', status: 'answered' });
    expect(answerState(closed, [closed])).toBe('settled');
    expect(entryTint(closed, [closed])).toBe('purple');
  });

  it("ignores her own replies — only llm answers count", () => {
    const hers = entry({ id: 'r1', reply_to: 'q1' });
    expect(answerState(q, [q, hers])).toBe('waiting');
  });

  it('tints llm rows orange until reviewed, processed rows purple, flagged rows accent', () => {
    const llm = entry({ id: 'l1', author: 'llm' });
    expect(entryTint(llm, [llm])).toBe('orange');
    expect(entryTint({ ...llm, reviewed: true }, [llm])).toBe('purple');
    const done = entry({ id: 'n1', processed: true });
    expect(entryTint(done, [done])).toBe('purple');
    const queued = entry({ id: 'n2', flagged: true });
    expect(entryTint(queued, [queued])).toBe('flagged');
    expect(entryTint(entry({ id: 'n3' }), [])).toBeNull();
  });
});

describe('queues and roll-ups', () => {
  const entries: Entry[] = [
    entry({ id: 'mine', flagged: true }),
    entry({ id: 'llm-flag', flagged: true, author: 'llm' }),
    entry({ id: 'llm-new', author: 'llm', reviewed: false }),
    entry({ id: 'llm-seen', author: 'llm', reviewed: true }),
    entry({ id: 'loose' }),
    entry({ id: 'q-open', kind: 'question', status: 'open', topics: ['t'], created: '2026-01-02 09:00' }),
    entry({ id: 'q-open-2', kind: 'question', status: 'open', topics: ['t'], created: '2026-01-03 09:00' }),
    entry({ id: 'q-done', kind: 'question', status: 'answered', topics: ['t'] }),
  ];

  it('flaggedQueue excludes llm outputs', () => {
    expect(flaggedQueue(entries).map((e) => e.id)).toEqual(['mine']);
  });

  it('counts unreviewed llm output (flagged llm rows included)', () => {
    expect(unreviewedCount(entries)).toBe(2);
  });

  it('openQuestions returns only open questions, newest first', () => {
    expect(openQuestions(entries).map((e) => e.id)).toEqual(['q-open-2', 'q-open']);
  });

  it('unfiledEntries returns topic-less entries newest first', () => {
    const pool = [
      entry({ id: 'old', created: '2026-01-01 08:00' }),
      entry({ id: 'new', created: '2026-01-05 08:00' }),
      entry({ id: 'filed', topics: ['t'], created: '2026-01-09 08:00' }),
    ];
    expect(unfiledEntries(pool).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('topicStats counts entries, queued, unreviewed, and open questions', () => {
    const pool = [
      entry({ id: 'a', topics: ['t'], flagged: true }),
      entry({ id: 'b', topics: ['t'], author: 'llm', reviewed: false }),
      entry({ id: 'c', topics: ['t'], kind: 'question', status: 'open' }),
      entry({ id: 'other', topics: ['x'] }),
    ];
    expect(topicStats('t', pool)).toEqual({ count: 3, flagged: 1, unreviewed: 1, open: 1 });
  });
});

describe('sessions', () => {
  const sessions: Session[] = [
    { id: 's1', status: 'done', mode: 'deep', entry_ids: ['q1'] },
    { id: 's2', status: 'queued', mode: 'deep', entry_ids: ['q2'] },
    { id: 's3', status: 'running', mode: 'distill', topics: ['t1'] },
  ];

  it('anySessionInFlight sees queued and running', () => {
    expect(anySessionInFlight(sessions)).toBe(true);
    expect(anySessionInFlight([{ id: 'x', status: 'done' }, { id: 'y', status: 'failed' }])).toBe(false);
  });

  it('activeDeepSession ignores finished sessions', () => {
    expect(activeDeepSession(sessions, 'q1')).toBeNull();
    expect(activeDeepSession(sessions, 'q2')?.id).toBe('s2');
  });

  it('activeDistillSession matches by topic', () => {
    expect(activeDistillSession(sessions, 't1')?.id).toBe('s3');
    expect(activeDistillSession(sessions, 't2')).toBeNull();
  });
});

describe('threadStructure', () => {
  it('nests in-thread replies chronologically under newest-first top levels', () => {
    const pool: Entry[] = [
      entry({ id: 'p1', topics: ['t'], created: '2026-01-01 10:00' }),
      entry({ id: 'p2', topics: ['t'], created: '2026-01-02 10:00' }),
      entry({ id: 'r-late', topics: ['t'], reply_to: 'p1', created: '2026-01-04 10:00' }),
      entry({ id: 'r-early', topics: ['t'], reply_to: 'p1', created: '2026-01-03 10:00' }),
      entry({ id: 'outside', topics: ['other'], created: '2026-01-05 10:00' }),
    ];
    const s = threadStructure(pool, 't');
    expect(s.topLevel.map((e) => e.id)).toEqual(['p2', 'p1']);
    expect(s.repliesOf.p1.map((e) => e.id)).toEqual(['r-early', 'r-late']);
  });

  it('treats a reply whose parent is outside the thread as top-level', () => {
    const pool: Entry[] = [
      entry({ id: 'orphan', topics: ['t'], reply_to: 'elsewhere', created: '2026-01-01 10:00' }),
    ];
    const s = threadStructure(pool, 't');
    expect(s.topLevel.map((e) => e.id)).toEqual(['orphan']);
    expect(s.repliesOf).toEqual({});
  });
});

describe('contextChain', () => {
  it('walks reply_to up to the root, note first', () => {
    const pool: Entry[] = [
      entry({ id: 'root', kind: 'question', text: 'the question' }),
      entry({ id: 'mid', author: 'llm', reply_to: 'root', file: 'report.md', text: 'the answer' }),
      entry({ id: 'leaf', reply_to: 'mid', text: 'follow-up' }),
    ];
    expect(contextChain(pool, 'leaf')).toEqual([
      { id: 'leaf', kind: 'note', snippet: 'follow-up', file: null, checked: true },
      { id: 'mid', kind: 'note', snippet: 'the answer', file: 'report.md', checked: true },
      { id: 'root', kind: 'question', snippet: 'the question', file: null, checked: true },
    ]);
  });

  it('guards against cycles and missing parents', () => {
    const pool: Entry[] = [
      entry({ id: 'a', reply_to: 'b' }),
      entry({ id: 'b', reply_to: 'a' }),
      entry({ id: 'dangling', reply_to: 'nope' }),
    ];
    expect(contextChain(pool, 'a').map((c) => c.id)).toEqual(['a', 'b']);
    expect(contextChain(pool, 'dangling').map((c) => c.id)).toEqual(['dangling']);
    expect(contextChain(pool, 'missing')).toEqual([]);
  });

  it('truncates snippets to 90 chars', () => {
    const long = 'x'.repeat(200);
    const pool = [entry({ id: 'a', text: long })];
    expect(contextChain(pool, 'a')[0].snippet).toHaveLength(90);
  });
});

describe('doc ids and articles', () => {
  const pool: Entry[] = [
    entry({ id: 'src1', kind: 'source' }),
    entry({ id: 'reply', author: 'llm', file: 'deep/report.md' }),
  ];

  it('resolveDocOwner handles entry:, note:, and unknown namespaces', () => {
    expect(resolveDocOwner('entry:src1', pool)).toBe('src1');
    expect(resolveDocOwner('note:deep/report.md', pool)).toBe('reply');
    expect(resolveDocOwner('note:unknown.md', pool)).toBeNull();
    expect(resolveDocOwner('journal:2026-01-01', pool)).toBeNull();
  });

  it('articlesWithText pairs fetched docs with their source entries only', () => {
    const docs = new Set(['entry:src1', 'entry:ghost', 'note:deep/report.md']);
    expect(articlesWithText(pool, docs)).toEqual([{ doc: 'entry:src1', entry: pool[0] }]);
  });
});

describe('edge notes', () => {
  it('edgeFor finds the topic-keyed distiller note', () => {
    const edge = [{ file: 'edge/long-covid.md', title: 'Edge', mtime: '2026-06-01' }];
    expect(edgeFor(edge, 'long-covid')).toBe(edge[0]);
    expect(edgeFor(edge, 'other')).toBeNull();
  });

  it('reviewedSince counts reviewed llm replies newer than the edge mtime', () => {
    const pool: Entry[] = [
      entry({ id: 'old', author: 'llm', reviewed: true, topics: ['t'], created: '2026-05-30 10:00' }),
      entry({ id: 'new', author: 'llm', reviewed: true, topics: ['t'], created: '2026-06-02 10:00' }),
      entry({ id: 'unreviewed', author: 'llm', topics: ['t'], created: '2026-06-03 10:00' }),
      entry({ id: 'hers', reviewed: true, topics: ['t'], created: '2026-06-03 10:00' }),
    ];
    expect(reviewedSince(pool, 't', '2026-06-01')).toBe(1);
  });
});

describe('formatting', () => {
  it('authorsShort renders 1, 2, and many authors', () => {
    expect(authorsShort(undefined)).toBe('');
    expect(authorsShort([{ given: 'Ada', family: 'Lovelace' }])).toBe('Ada Lovelace');
    expect(
      authorsShort([
        { given: 'A', family: 'One' },
        { given: 'B', family: 'Two' },
      ]),
    ).toBe('A One & B Two');
    expect(
      authorsShort([{ family: 'One' }, { family: 'Two' }, { family: 'Three' }]),
    ).toBe('One et al.');
  });

  it('originFile extracts the note: origin path', () => {
    expect(originFile(entry({ id: 'a', origin: 'note:papers/x.md' }))).toBe('papers/x.md');
    expect(originFile(entry({ id: 'b' }))).toBe('');
  });
});

describe('landingLabel', () => {
  const fronts: Front[] = [{ id: 'health', name: 'Health' }];
  const byId: Record<string, Topic> = {
    t1: { id: 't1', name: 'Long COVID', status: 'active', fronts: ['health'] },
    t2: { id: 't2', name: 'Baby plan', status: 'active' },
    t3: { id: 't3', name: 'Stale front', status: 'active', fronts: ['deleted-front'] },
  };

  it('one topic with a known front: emoji + name', () => {
    expect(landingLabel(['t1'], byId, fronts)).toBe('🩺 Long COVID');
  });

  it('one topic with no front: name only', () => {
    expect(landingLabel(['t2'], byId, fronts)).toBe('Baby plan');
  });

  it('one topic whose front id is not in the known fronts list: name only (missing emoji)', () => {
    expect(landingLabel(['t3'], byId, fronts)).toBe('Stale front');
  });

  it('two or more topics: first name + N more', () => {
    expect(landingLabel(['t1', 't2'], byId, fronts)).toBe('Long COVID + 1 more');
    expect(landingLabel(['t1', 't2', 't3'], byId, fronts)).toBe('Long COVID + 2 more');
  });

  it('no topics: waiting in Uncategorized', () => {
    expect(landingLabel([], byId, fronts)).toBe('waiting in Uncategorized');
  });
});

describe('roundMagnitude', () => {
  it('renders sub-1000 counts as-is', () => {
    expect(roundMagnitude(0)).toBe('0');
    expect(roundMagnitude(42)).toBe('42');
    expect(roundMagnitude(999)).toBe('999');
  });

  it('rounds thousands to the nearest k, never a raw comma count', () => {
    expect(roundMagnitude(1000)).toBe('1k');
    expect(roundMagnitude(12431)).toBe('12k');
    expect(roundMagnitude(12499)).toBe('12k');
    expect(roundMagnitude(12500)).toBe('13k');
  });

  it('floors small-but-nonzero thousands at 1k, never 0k', () => {
    expect(roundMagnitude(1010)).toBe('1k');
  });

  it('renders millions with one decimal', () => {
    expect(roundMagnitude(2_400_000)).toBe('2.4M');
    expect(roundMagnitude(3_000_000)).toBe('3M');
  });
});

describe('fmtRunDuration', () => {
  it('renders sub-minute runs as seconds', () => {
    expect(fmtRunDuration(45)).toBe('45s');
  });

  it('renders minutes + seconds, zero-padded', () => {
    expect(fmtRunDuration(160)).toBe('2m40s');
    expect(fmtRunDuration(120)).toBe('2m00s');
  });

  it('renders hours + minutes, zero-padded, for long runs', () => {
    expect(fmtRunDuration(3900)).toBe('1h05m');
  });

  it('renders empty for zero, negative, null, or undefined', () => {
    expect(fmtRunDuration(0)).toBe('');
    expect(fmtRunDuration(-5)).toBe('');
    expect(fmtRunDuration(null)).toBe('');
    expect(fmtRunDuration(undefined)).toBe('');
  });
});
