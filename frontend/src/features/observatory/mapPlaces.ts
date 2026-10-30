/**
 * mapPlaces.ts — where every session stands on the desktop map, as pure
 * functions, so "nothing falls through" can be tested rather than hoped for.
 *
 * What this is, in plain English: the map (RosterMap.tsx) draws each room as
 * swarm circles, project boxes and rings for sessions working alone, with a side
 * side for what wants her. This file answers two questions.
 *
 *   placeRoster   Where does each session LIVE on the map? Each has exactly one
 *                 home: drawn as a helper (the band, a circle's middle, a project
 *                 box), a member of a swarm's circle, a ring in a project or a
 *                 room, the room's Done drawer, or, if none of those claims it,
 *                 a ring in "Other sessions". The server's list of who works
 *                 alone isn't the whole roster, which is why the last one exists.
 *   sideGroups    What goes in the "Needs you" list on the right? Each session goes in at most one
 *                 group: asking, a plan up for her go, a failed turn, or a reply
 *                 to read. A session in a group still has its home on the map;
 *                 the side column is where she acts on it. Each group is in the
 *                 room's own order (roomOrder.ts).
 *
 * narrowPlaces is what the filters do to the map: it drops the circles, boxes
 * and rings that have nothing matching.
 *
 * Swarms stand in the room's own order, so one that needs her floats to the top
 * as on the phone's list (roomOrder.ts). Sessions working alone keep the page's
 * order: they're a list she finds her way around by where things are.
 *
 * Touches: RosterMap.tsx (the only caller), roomOrder.ts (the swarm view and the
 * order), sessionFilters.ts (the state rules), swarmApi.ts (the room view),
 * mapPlaces.test.ts.
 *
 * Prompt that produced it: "it needs to have a better dashboard UI, rather than
 * like the easy scroll UI on desktop."
 */
import type { SessionMeta } from './api';
import { foldsIntoDone, orderRoom, sessionPlace, swarmPlace, type SwarmView } from './roomOrder';
import { cardState, isAsking } from './sessionFilters';
import type { MemberState, ProjectView, RoomView, Swarm } from './swarmApi';

/** Lanes with a room of their own behind a door: their swarms aren't on the map. */
const DOOR_LANES = new Set(['research', 'linear']);

/** One session drawn on its own, as a ring and its name. */
export interface MapRing {
  conv: string;
  title: string;
  state: MemberState;
  summary: string | null;
}

export interface MapProject {
  project: ProjectView;
  swarms: SwarmView[];
  solos: MapRing[];
}

export interface MapRoom {
  room: string;
  swarms: SwarmView[];
  projects: MapProject[];
  solos: MapRing[];
  /** Sessions nothing else claimed. Never dropped, and never hidden. */
  others: MapRing[];
  done: SessionMeta[];
  /** How many of this room's swarms are closed, for the show-closed switch. */
  closedCount: number;
}

export function ringOf(meta: SessionMeta, summary?: string | null): MapRing {
  return {
    conv: meta.id,
    title: meta.title || meta.id,
    state: isAsking(meta) ? 'needs_input' : meta.running ? 'working' : 'silent',
    summary: summary ?? meta.summary ?? null,
  };
}

/** Every session the map draws as a helper rather than a ring: each swarm's,
 * each room's and each project room's. */
export function helperConvs(swarms: Swarm[], roomViews: Map<string, RoomView | undefined>): Set<string> {
  const helpers = new Set<string>();
  for (const swarm of swarms) if (swarm.helper_conv) helpers.add(swarm.helper_conv);
  for (const view of roomViews.values()) {
    if (view?.helper_conv) helpers.add(view.helper_conv);
    for (const project of view?.projects ?? []) if (project.helper_conv) helpers.add(project.helper_conv);
  }
  return helpers;
}

/** Give every session in `sessions` its one home on the map. `sessions` is
 * roomRoster's list, `views` the swarms being drawn, `swarms` all of them (closed
 * ones too). A lane with no room here lands in `stray`, as on the column. */
export function placeRoster({
  rooms,
  stray,
  sessions,
  views,
  swarms,
  roomViews,
}: {
  rooms: readonly string[];
  stray: string | null;
  sessions: SessionMeta[];
  views: SwarmView[];
  swarms: Swarm[];
  roomViews: Map<string, RoomView | undefined>;
}): MapRoom[] {
  const roomOf = (lane: string | undefined): string =>
    lane && rooms.includes(lane) ? lane : stray && rooms.includes(stray) ? stray : rooms[0];
  const helpers = helperConvs(swarms, roomViews);

  // Who's in a circle, from the swarm views, which have already dropped the
  // finished members.
  const drawn = orderRoom(
    views.filter((view) => !DOOR_LANES.has(view.swarm.lane)).map((view) => ({ item: view, ...swarmPlace(view) })),
  );
  const inCircle = new Set(drawn.flatMap((view) => view.members.map((member) => member.conv)));

  // Who the server says is working alone, and where.
  const projects: { room: string; project: ProjectView }[] = [];
  const soloProject = new Map<string, ProjectView>();
  const soloSummary = new Map<string, string | null>();
  for (const room of rooms) {
    const view = roomViews.get(room);
    for (const solo of view?.solos ?? []) soloSummary.set(solo.conv, solo.summary);
    for (const project of view?.projects ?? []) {
      projects.push({ room, project });
      for (const solo of project.solos) {
        soloProject.set(solo.conv, project);
        soloSummary.set(solo.conv, solo.summary);
      }
    }
  }

  const placed = new Map<string, MapRoom>(
    rooms.map((room) => [
      room,
      {
        room,
        swarms: [],
        projects: [],
        solos: [],
        others: [],
        done: [],
        closedCount: swarms.filter((s) => s.closed && roomOf(s.lane) === room && !DOOR_LANES.has(s.lane)).length,
      },
    ]),
  );
  const boxes = new Map<string, MapProject>();
  for (const { room, project } of projects) {
    const box: MapProject = { project, swarms: [], solos: [] };
    boxes.set(project.id, box);
    placed.get(room)!.projects.push(box);
  }

  // Stand each swarm in its project's box if it has one, else in its room.
  const boxOfSwarm = new Map<number, MapProject>();
  for (const box of boxes.values()) for (const id of box.project.swarm_ids) boxOfSwarm.set(id, box);
  for (const view of drawn) {
    const box = boxOfSwarm.get(view.swarm.id);
    if (box) box.swarms.push(view);
    else placed.get(roomOf(view.swarm.lane))?.swarms.push(view);
  }

  // Give each session its one home, first claim wins. Done comes before the
  // circles because a finished member has already left its circle; one that's
  // done but still asking stays out of the drawer, and lands in Other sessions.
  for (const meta of sessions) {
    if (helpers.has(meta.id) || inCircle.has(meta.id)) continue;
    const room = placed.get(roomOf(meta.lane));
    if (!room) continue;
    if (foldsIntoDone(meta)) {
      room.done.push(meta);
      continue;
    }
    const box = soloProject.get(meta.id);
    if (box) boxes.get(box.id)!.solos.push(ringOf(meta, soloSummary.get(meta.id)));
    else if (soloSummary.has(meta.id)) room.solos.push(ringOf(meta, soloSummary.get(meta.id)));
    else room.others.push(ringOf(meta));
  }
  return [...placed.values()];
}

/** What a helper looks after: for a room helper its whole room, for a project
 * helper its project room. Null for any other session, a swarm helper included. */
export type HelperScope = { kind: 'room'; place: MapRoom } | { kind: 'project'; box: MapProject };

export function helperScope(
  conv: string,
  places: MapRoom[],
  roomViews: Map<string, RoomView | undefined>,
): HelperScope | null {
  for (const place of places) {
    if (roomViews.get(place.room)?.helper_conv === conv) return { kind: 'room', place };
    const box = place.projects.find((candidate) => candidate.project.helper_conv === conv);
    if (box) return { kind: 'project', box };
  }
  return null;
}

/** A room's numbers, for its heading: how many sessions are open in it, how many
 * need her, how many are running, how many are done. */
export interface RoomCensus {
  open: number;
  needing: number;
  running: number;
  done: number;
}

export function roomCensus(room: MapRoom): RoomCensus {
  const views = [...room.swarms, ...room.projects.flatMap((box) => box.swarms)];
  const rings = [...room.solos, ...room.others, ...room.projects.flatMap((box) => box.solos)];
  return {
    open: views.reduce((total, view) => total + view.members.length, 0) + rings.length,
    needing:
      views.reduce((total, view) => total + view.counts.needs_input, 0) +
      rings.filter((ring) => ring.state === 'needs_input').length,
    running:
      views.reduce((total, view) => total + view.counts.working, 0) +
      rings.filter((ring) => ring.state === 'working').length,
    done: room.done.length,
  };
}

/** What a filter leaves of a room: only the circles with a matching member, the
 * boxes with anything matching, and the matching rings and done cards. */
export function narrowPlaces(rooms: MapRoom[], matches: (conv: string) => boolean): MapRoom[] {
  const swarmMatches = (view: SwarmView) => view.members.some((member) => matches(member.conv));
  const ringMatches = (ring: MapRing) => matches(ring.conv);
  return rooms.map((room) => ({
    ...room,
    swarms: room.swarms.filter(swarmMatches),
    projects: room.projects
      .map((box) => ({ ...box, swarms: box.swarms.filter(swarmMatches), solos: box.solos.filter(ringMatches) }))
      .filter((box) => box.swarms.length > 0 || box.solos.length > 0),
    solos: room.solos.filter(ringMatches),
    others: room.others.filter(ringMatches),
    done: room.done.filter((meta) => matches(meta.id)),
  }));
}

export interface SideGroups {
  asking: SessionMeta[];
  plans: SessionMeta[];
  errors: SessionMeta[];
  toRead: SessionMeta[];
  /** Filtered only: what matches the filter without wanting anything, so the
   * column can honestly list everything the filter found. */
  rest: SessionMeta[];
}

/** Sort sessions into the side column's groups. `matches` is the pressed filters,
 * or null with none down. A helper only comes up for a question: its replies
 * aren't hers to read through, unless a filter asked for them. A folded done
 * session is in its room's Done drawer, not here. */
export function sideGroups(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  helpers: ReadonlySet<string>,
  matches: ((meta: SessionMeta) => boolean) | null,
  nowMs: number = Date.now(),
): SideGroups {
  const groups: SideGroups = { asking: [], plans: [], errors: [], toRead: [], rest: [] };
  const ordered = orderRoom(sessions.map((meta) => ({ item: meta, ...sessionPlace(meta, opened[meta.id], nowMs) })));
  for (const meta of ordered) {
    if (matches && !matches(meta)) continue;
    if (isAsking(meta)) {
      groups.asking.push(meta);
      continue;
    }
    if (foldsIntoDone(meta)) continue;
    const state = helpers.has(meta.id) ? 'rest' : cardState(meta, opened[meta.id], nowMs);
    if (state === 'plan') groups.plans.push(meta);
    else if (state === 'error') groups.errors.push(meta);
    else if (state === 'unread') groups.toRead.push(meta);
    else if (matches) groups.rest.push(meta);
  }
  return groups;
}

/** What's waiting on her in one room, for the summary on the right. `sessions`
 * are the ones behind the numbers, so a click can show exactly those. */
export interface RoomNeeds {
  room: string;
  sessions: SessionMeta[];
  groups: SideGroups;
}

/** Sort what's waiting by room. A session counts in the room the overview draws
 * it in, so these numbers agree with the room's heading even when a swarm has a
 * member from another room. One the overview doesn't draw (a helper asking
 * something) counts in its own lane's room. */
export function needsByRoom(
  places: MapRoom[],
  stray: string | null,
  sessions: SessionMeta[],
  opened: Record<string, string>,
  helpers: ReadonlySet<string>,
  nowMs: number = Date.now(),
): RoomNeeds[] {
  const rooms = places.map((place) => place.room);
  const home = new Map<string, string>();
  for (const place of places) {
    const views = [...place.swarms, ...place.projects.flatMap((box) => box.swarms)];
    const rings = [...place.solos, ...place.others, ...place.projects.flatMap((box) => box.solos)];
    for (const view of views) for (const member of view.members) home.set(member.conv, place.room);
    for (const ring of rings) home.set(ring.conv, place.room);
    for (const meta of place.done) home.set(meta.id, place.room);
  }
  const roomOf = (meta: SessionMeta) =>
    home.get(meta.id) ??
    (meta.lane && rooms.includes(meta.lane) ? meta.lane : stray && rooms.includes(stray) ? stray : rooms[0]);
  return rooms.map((room) => {
    const inRoom = sessions.filter((meta) => roomOf(meta) === room);
    return { room, sessions: inRoom, groups: sideGroups(inRoom, opened, helpers, null, nowMs) };
  });
}

/** How many things are waiting in these groups. */
export function waitingCount(groups: SideGroups): number {
  return groups.asking.length + groups.plans.length + groups.errors.length + groups.toRead.length;
}

/** The one line that stands in for the side column on a narrower map. */
export function stripLine(groups: SideGroups): string {
  const parts = countWords(groups);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing waiting on you';
}

/** The groups' counts in words, leaving out what's empty. */
export function countWords(groups: SideGroups): string[] {
  const parts: string[] = [];
  if (groups.asking.length > 0) parts.push(`${groups.asking.length} need${groups.asking.length === 1 ? 's' : ''} you`);
  if (groups.plans.length > 0) parts.push(`${groups.plans.length} plan${groups.plans.length === 1 ? '' : 's'}`);
  if (groups.errors.length > 0) parts.push(`${groups.errors.length} failed`);
  if (groups.toRead.length > 0) parts.push(`${groups.toRead.length} to read`);
  return parts;
}
