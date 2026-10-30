/**
 * mapPlaces.test.ts — the desktop map's promise: every session on the roster has
 * exactly one home, whatever state it's in, and the filters and the side column
 * read the same sessions the map draws.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from './api';
import { helperConvs, narrowPlaces, placeRoster, sideGroups, stripLine, type MapRoom } from './mapPlaces';
import { swarmView } from './roomOrder';
import { matchesAny, type RosterFilter } from './sessionFilters';
import type { RoomView, Swarm } from './swarmApi';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  lane: 'coding',
  last_at: at(600),
  ...over,
});
const member = (conv: string) => ({
  conv,
  title: conv,
  lane: 'coding',
  state: 'silent' as const,
  joined_at: at(900),
  summary: null,
  summary_at: null,
});
const swarm = (id: number, members: string[], over: Partial<Swarm> = {}): Swarm => ({
  id,
  name: `Swarm ${id}`,
  named: true,
  lane: 'coding',
  helper_conv: `helper-${id}`,
  summary: null,
  summary_at: null,
  created_at: at(900),
  counts: { working: 0, silent: members.length, needs_input: 0 },
  members: members.map(member),
  links: [],
  ...over,
});
const solo = (conv: string) => ({ conv, title: conv, state: 'silent' as const, summary: null });

/** A real room's worth of variety: every way a session can stand. */
function scene() {
  const sessions = [
    session('in-swarm', { awaiting_input: 'which one?' }),
    session('in-project-swarm', { running: true }),
    session('alone'),
    session('alone-in-project'),
    session('alone-personal', { lane: 'personal' }),
    session('unknown-to-server'),
    session('stray', { lane: 'orchestra' }),
    session('done-solo', { done_at: at(5), final_at: at(5) }),
    session('done-member', { done_at: at(5), final_at: at(5) }),
    session('done-but-asking', { done_at: at(5), awaiting_input: 'one more thing?' }),
    session('handed-on', { retired: true, retired_at: at(5) }),
    session('room-helper'),
    session('helper-1'),
    session('project-helper'),
  ];
  const swarms = [
    swarm(1, ['in-swarm', 'done-member', 'other-room-member']),
    swarm(2, ['in-project-swarm']),
    swarm(3, ['gone-a', 'gone-b'], { closed: true }),
  ];
  const roomViews = new Map<string, RoomView | undefined>([
    [
      'coding',
      {
        room: 'coding',
        helper_conv: 'room-helper',
        solos: [solo('alone'), solo('not-on-the-roster')],
        moves: [],
        projects: [
          {
            id: 'bf',
            name: 'Based Foods',
            room: 'coding',
            helper_conv: 'project-helper',
            swarm_ids: [2],
            solos: [solo('alone-in-project')],
            moves: [],
          },
        ],
      },
    ],
    ['personal', { room: 'personal', helper_conv: null, solos: [solo('alone-personal')], moves: [] }],
  ]);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const views = swarms.filter((s) => !s.closed).map((s) => swarmView(s, byId, {}, NOW));
  const rooms = placeRoster({ rooms: ['coding', 'personal'], stray: 'coding', sessions, views, swarms, roomViews });
  return { sessions, swarms, roomViews, rooms };
}

/** Every session the map draws, once per time it's drawn. */
function drawnOn(rooms: MapRoom[]): string[] {
  return rooms.flatMap((room) => [
    ...room.swarms.flatMap((view) => view.members.map((m) => m.conv)),
    ...room.projects.flatMap((box) => [
      ...box.swarms.flatMap((view) => view.members.map((m) => m.conv)),
      ...box.solos.map((ring) => ring.conv),
    ]),
    ...room.solos.map((ring) => ring.conv),
    ...room.others.map((ring) => ring.conv),
    ...room.done.map((meta) => meta.id),
  ]);
}

describe('every session has one home', () => {
  it('lands every roster session exactly once, helpers in their own seats', () => {
    const { sessions, swarms, roomViews, rooms } = scene();
    const drawn = drawnOn(rooms);
    const helpers = helperConvs(swarms, roomViews);
    for (const { id } of sessions) {
      const times = drawn.filter((conv) => conv === id).length;
      expect([id, times]).toEqual([id, helpers.has(id) ? 0 : 1]);
    }
  });

  it('stands each in the right place', () => {
    const { rooms } = scene();
    const [coding, personal] = rooms;
    expect(coding.swarms.map((v) => v.swarm.id)).toEqual([1]);
    expect(coding.projects[0].swarms.map((v) => v.swarm.id)).toEqual([2]);
    expect(coding.projects[0].solos.map((r) => r.conv)).toEqual(['alone-in-project']);
    expect(coding.solos.map((r) => r.conv)).toEqual(['alone']);
    // Nobody on the server's solo list, not in a swarm, not done: never dropped.
    expect(coding.others.map((r) => r.conv)).toEqual(['unknown-to-server', 'stray', 'done-but-asking']);
    expect(coding.done.map((m) => m.id)).toEqual(['done-solo', 'done-member', 'handed-on']);
    expect(personal.solos.map((r) => r.conv)).toEqual(['alone-personal']);
    expect(coding.closedCount).toBe(1);
  });
});

describe('the filters on the map', () => {
  it('hide circles and boxes with no match, and keep the ones that have one', () => {
    const { rooms } = scene();
    const [coding] = narrowPlaces(rooms, (conv) => conv === 'in-swarm');
    expect(coding.swarms.map((v) => v.swarm.id)).toEqual([1]);
    expect(coding.projects).toEqual([]);
    expect(coding.solos).toEqual([]);
    expect(coding.others).toEqual([]);
  });

  it('a project box stays for one matching ring, without its other swarms', () => {
    const { rooms } = scene();
    const [coding] = narrowPlaces(rooms, (conv) => conv === 'alone-in-project');
    expect(coding.projects[0].solos.map((r) => r.conv)).toEqual(['alone-in-project']);
    expect(coding.projects[0].swarms).toEqual([]);
  });

  it('Needs you and Planning read the sessions, and union with the colours', () => {
    const planning = session('planner', { spinoff_stage: 'plan' });
    const planReady = session('ready', { spinoff_stage: 'plan', plan_ready: { summary: 'x', at: at(5) } });
    const finished = session('finished-plan', { spinoff_stage: 'plan', done_at: at(5) });
    const asking = session('asking', { awaiting_input: 'q' });
    const running = session('running', { running: true });
    const hit = (meta: SessionMeta, filters: RosterFilter[]) => matchesAny(meta, undefined, filters, NOW);
    expect([planning, planReady, finished, asking, running].filter((m) => hit(m, ['planning'])).map((m) => m.id)).toEqual([
      'planner',
      'ready',
    ]);
    expect([planning, asking, running].filter((m) => hit(m, ['needs_you'])).map((m) => m.id)).toEqual(['asking']);
    expect([planning, asking, running].filter((m) => hit(m, ['needs_you', 'running'])).map((m) => m.id)).toEqual([
      'asking',
      'running',
    ]);
  });
});

describe('the side column', () => {
  const sessions = [
    session('reply', { last_at: at(30) }),
    session('old-question', { awaiting_input: 'q', last_at: at(50) }),
    session('new-question', { awaiting_input: 'q', last_at: at(5) }),
    session('plan', { plan_ready: { summary: 'x', at: at(5) }, last_at: at(20) }),
    session('broken', { last_error: 'boom', last_at: at(20) }),
    session('working', { running: true, last_at: at(1) }),
    session('done', { done_at: at(5), final_at: at(5) }),
    session('done-asking', { done_at: at(5), awaiting_input: 'q', last_at: at(1) }),
    session('helper-reply', { last_at: at(30) }),
  ];
  const opened = { working: at(0), done: at(0) };

  it('puts each in one group, longest wait first, with a done question still up', () => {
    const groups = sideGroups(sessions, opened, new Set(['helper-reply']), null, NOW);
    expect(groups.asking.map((m) => m.id)).toEqual(['old-question', 'new-question', 'done-asking']);
    expect(groups.plans.map((m) => m.id)).toEqual(['plan']);
    expect(groups.errors.map((m) => m.id)).toEqual(['broken']);
    expect(groups.toRead.map((m) => m.id)).toEqual(['reply']);
    expect(groups.rest).toEqual([]);
    expect(stripLine(groups)).toBe('3 need you · 1 plan · 1 failed · 1 to read');
  });

  it('narrows to what matches, including what wants nothing', () => {
    const groups = sideGroups(sessions, opened, new Set(), (meta) => meta.running === true, NOW);
    expect(groups.rest.map((m) => m.id)).toEqual(['working']);
    expect(groups.asking).toEqual([]);
    expect(stripLine({ ...groups, rest: [] })).toBe('Nothing waiting on you');
  });
});
