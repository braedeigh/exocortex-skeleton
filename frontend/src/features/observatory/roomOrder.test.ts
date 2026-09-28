/**
 * roomOrder.test.ts — pins the room's three bands (waiting on her, orange
 * first; running; done, most recently finished last) and how a swarm card
 * reads its members through the roster (done and retired dropped, colours by
 * the session cards' rule).
 */
import { describe, expect, it } from 'vitest';
import { orderMembers, orderRoom, sessionPlace, swarmPlace, swarmView } from './roomOrder';
import type { SessionMeta } from './api';
import type { Swarm, SwarmMember } from './swarmApi';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const approval = { command: 'x' } as SessionMeta['awaiting_approval'];

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
  orderRoom(sessions.map((s) => ({ item: s.id, ...sessionPlace(s, opened[s.id], NOW) })));

describe('orderRoom', () => {
  it('stacks waiting on her, then running, then done', () => {
    const sessions = [
      session('done', { done_at: ago(10 * MIN), final_at: ago(10 * MIN) }),
      session('running', { running: true }),
      session('asking', { awaiting_input: 'q' }),
    ];
    expect(roomIds(sessions)).toEqual(['asking', 'running', 'done']);
  });

  it('leads the waiting band with orange, each part longest-waiting first', () => {
    const sessions = [
      session('openedOld', { last_at: ago(300 * MIN) }),
      session('newAsk', { awaiting_input: 'q', last_at: ago(2 * MIN) }),
      session('unread', { last_at: ago(20 * MIN) }),
      session('oldApproval', { awaiting_approval: approval, last_at: ago(40 * MIN) }),
      session('openedNew', { last_at: ago(100 * MIN) }),
    ];
    const opened = { openedOld: ago(0), openedNew: ago(0) };
    expect(roomIds(sessions, opened)).toEqual(['oldApproval', 'unread', 'newAsk', 'openedOld', 'openedNew']);
  });

  it('keeps running sessions in the order the page handed them', () => {
    const sessions = [
      session('first', { running: true, last_at: ago(1 * MIN) }),
      session('second', { running: true, last_at: ago(90 * MIN) }),
    ];
    expect(roomIds(sessions)).toEqual(['first', 'second']);
  });

  it('sinks done and handed-on sessions, the most recently finished last', () => {
    const sessions = [
      session('doneRecent', { done_at: ago(5 * MIN), final_at: ago(5 * MIN) }),
      session('handedOn', { retired: true, retired_at: ago(60 * MIN) }),
      session('doneOld', { done_at: ago(30 * MIN), final_at: ago(30 * MIN) }),
      session('idle', { last_at: ago(500 * MIN) }),
    ];
    expect(roomIds(sessions, { idle: ago(0) })).toEqual(['idle', 'handedOn', 'doneOld', 'doneRecent']);
  });

  it('keeps a done session in the done band even while a peer wakes it', () => {
    const woken = session('a', { done_at: ago(30 * MIN), running: true });
    expect(sessionPlace(woken, undefined, NOW).tier).toBe('done');
  });
});

describe('swarmView', () => {
  it('leaves done and retired members off the card and out of its counts', () => {
    const roster = new Map([
      ['live', session('live', { running: true })],
      ['done', session('done', { done_at: ago(10 * MIN) })],
    ]);
    const view = swarmView(
      swarm([member('live'), member('done'), member('gone', { retired: true, state: 'needs_input' })]),
      roster,
      {},
      NOW,
    );
    expect(view.members.map((m) => m.conv)).toEqual(['live']);
    expect(view.counts).toEqual({ working: 1, silent: 0, needs_input: 0 });
  });

  it('colours members from the roster, so a pending approval puts the swarm with the orange ones', () => {
    const roster = new Map([
      ['a', session('a', { awaiting_approval: approval, last_at: ago(30 * MIN) })],
      ['b', session('b', { running: true })],
    ]);
    const view = swarmView(swarm([member('a'), member('b')]), roster, {}, NOW);
    expect(view.state).toBe('needs_input');
    expect(swarmPlace(view)).toEqual({ tier: 'orange', at: ago(30 * MIN) });
  });

  it('sinks a swarm with nobody left at work to the done band', () => {
    const roster = new Map([['a', session('a', { done_at: ago(10 * MIN) })]]);
    expect(swarmPlace(swarmView(swarm([member('a')]), roster, {}, NOW)).tier).toBe('done');
  });

  it('chips members asking first, then waiting (dotted first), then working', () => {
    const roster = new Map([
      ['quiet', session('quiet', { last_at: ago(90 * MIN) })],
      ['newAsk', session('newAsk', { awaiting_input: 'q', last_at: ago(1 * MIN) })],
      ['busy', session('busy', { running: true })],
      ['unread', session('unread', { last_at: ago(3 * MIN) })],
      ['oldAsk', session('oldAsk', { awaiting_input: 'q', last_at: ago(50 * MIN) })],
    ]);
    const view = swarmView(
      swarm([member('quiet'), member('newAsk'), member('busy'), member('unread'), member('oldAsk')]),
      roster,
      { quiet: ago(0) },
      NOW,
    );
    expect(orderMembers(view.members).map((m) => m.conv)).toEqual(['oldAsk', 'unread', 'newAsk', 'quiet', 'busy']);
  });
});
