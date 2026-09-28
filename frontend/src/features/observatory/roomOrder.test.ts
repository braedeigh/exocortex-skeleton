/**
 * roomOrder.test.ts — pins the room's order (orange longest-waiting first,
 * then red, purple, grey, each of those in page order) and how a swarm card
 * reads its members through the roster (retired dropped, colours by the
 * session cards' rule).
 */
import { describe, expect, it } from 'vitest';
import { orderMembers, orderRoom, sessionTier, swarmTier, swarmView } from './roomOrder';
import type { SessionMeta } from './api';
import type { Swarm, SwarmMember } from './swarmApi';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  last_at: ago(5 * MIN),
  ...over,
});

const member = (conv: string, over: Partial<SwarmMember> = {}): SwarmMember => ({
  conv,
  title: conv,
  lane: 'coding',
  state: 'silent',
  joined_at: ago(60 * MIN),
  summary: null,
  summary_at: null,
  ...over,
});

const swarm = (members: SwarmMember[]): Swarm => ({
  id: 1,
  name: 'S',
  named: true,
  lane: 'coding',
  helper_conv: null,
  summary: null,
  summary_at: null,
  created_at: ago(90 * MIN),
  counts: { working: 0, silent: 0, needs_input: 0 },
  members,
  links: [],
});

/** Order a list of sessions the way a room does, returning their ids. */
const roomIds = (sessions: SessionMeta[], opened: Record<string, string> = {}) =>
  orderRoom(
    sessions.map((s) => ({ item: s.id, tier: sessionTier(s, opened[s.id], NOW), waitingSince: s.last_at })),
  );

describe('orderRoom', () => {
  it('floats asking sessions to the top, longest-waiting first', () => {
    const sessions = [
      session('idle', { last_at: ago(300 * MIN) }),
      session('newAsk', { awaiting_input: 'q', last_at: ago(2 * MIN) }),
      session('running', { running: true }),
      session('oldAsk', { awaiting_approval: { command: 'x' } as SessionMeta['awaiting_approval'], last_at: ago(40 * MIN) }),
    ];
    expect(roomIds(sessions, { idle: ago(0) })).toEqual(['oldAsk', 'newAsk', 'running', 'idle']);
  });

  it('puts broken after asking and before working, and keeps page order within a tier', () => {
    const sessions = [
      session('rest1', { last_at: ago(300 * MIN) }),
      session('work1', { running: true }),
      session('broken', { last_error: 'boom' }),
      session('rest2', { last_at: ago(200 * MIN) }),
      session('work2', { running: true }),
    ];
    const opened = { rest1: ago(0), rest2: ago(0) };
    expect(roomIds(sessions, opened)).toEqual(['broken', 'work1', 'work2', 'rest1', 'rest2']);
  });

  it('leaves an unread reply among the grey ones rather than floating it', () => {
    // Unread and idle for hours: grey (with an orange dot), not orange.
    expect(sessionTier(session('a', { last_at: ago(300 * MIN) }), undefined, NOW)).toBe('resting');
  });
});

describe('swarmView', () => {
  it('leaves retired members off the card and out of its counts', () => {
    const view = swarmView(
      swarm([member('a'), member('b', { retired: true, state: 'needs_input' })]),
      new Map(),
      {},
      NOW,
    );
    expect(view.members.map((m) => m.conv)).toEqual(['a']);
    expect(view.counts).toEqual({ working: 0, silent: 1, needs_input: 0 });
  });

  it('colours members from the roster, so a pending approval makes the swarm orange', () => {
    const roster = new Map([
      ['a', session('a', { awaiting_approval: { command: 'x' } as SessionMeta['awaiting_approval'], last_at: ago(30 * MIN) })],
      ['b', session('b', { running: true })],
    ]);
    const view = swarmView(swarm([member('a'), member('b')]), roster, {}, NOW);
    expect(view.state).toBe('needs_input');
    expect(swarmTier(view)).toBe('asking');
    expect(view.waitingSince).toBe(ago(30 * MIN));
  });

  it('marks a silent member with an unopened reply as unread, still silent', () => {
    const view = swarmView(swarm([member('a')]), new Map([['a', session('a')]]), {}, NOW);
    expect(view.members[0]).toMatchObject({ state: 'silent', unread: true });
  });

  it('chips members asking-first, longest wait on top, then working, then silent', () => {
    const roster = new Map([
      ['quiet', session('quiet')],
      ['newAsk', session('newAsk', { awaiting_input: 'q', last_at: ago(1 * MIN) })],
      ['busy', session('busy', { running: true })],
      ['oldAsk', session('oldAsk', { awaiting_input: 'q', last_at: ago(50 * MIN) })],
    ]);
    const view = swarmView(
      swarm([member('quiet'), member('newAsk'), member('busy'), member('oldAsk')]),
      roster,
      {},
      NOW,
    );
    expect(orderMembers(view.members).map((m) => m.conv)).toEqual(['oldAsk', 'newAsk', 'busy', 'quiet']);
  });
});
