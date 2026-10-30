/**
 * RosterMap.tsx — the Observatory on a desktop: everything at a glance on the
 * left, and the detail of whatever she clicks into on the right.
 *
 * What this is, in plain English:
 *
 *   - TOP: the room helper's band, then one row with the '+', the filters, the
 *     sort, the search box, the Keeper's door and the memory meter. RosterPage
 *     hands these in; they don't scroll.
 *   - LEFT, the overview. Each room is a heading with its numbers ("12 open · 5
 *     need you · 2 running"), its project rooms as boxes, and inside them a small
 *     tile per swarm and one line per session. Nothing here tells the whole story
 *     of anything: a tile says what the swarm is and how many need her, drawn as
 *     a tiny circle of dots (MiniSwarm); a line is a session's dot and its name.
 *   - RIGHT, wider, the detail. It opens on what needs her: the questions as full
 *     cards, then plans, failures and replies to read. Clicking a swarm, a project
 *     room or a room's heading swaps it to that thing's whole story, with a way
 *     back: the swarm's network and members, the project helper and its swarms,
 *     the room's sessions as cards with its Done drawer and past sessions.
 *     Clicking a session's line opens the session itself, in the pane on the right
 *     of this page (shell/panels/conversationRouting.ts).
 *   - FOOT: one slim row of doors to the other rooms, stopping short of the notes
 *     pill's corner.
 *
 * Each side scrolls by itself; the page as a whole doesn't. On a narrower panel
 * (RosterPage decides by measuring it) the right side gives way to a one-line
 * strip, "3 need you · 2 plans", and clicking in swaps the overview for the detail.
 *
 * With filters down, the overview hides the tiles, boxes and lines with no match,
 * and the right side narrows to the matching sessions. Where each session stands,
 * and what the filters do to that, is mapPlaces.ts (tested); this file only draws.
 *
 * Touches: RosterPage.tsx (owns the state, draws this), mapPlaces.ts, RoomMap.tsx
 * (MapBody, for a project room's detail), SwarmStack.tsx (a swarm's detail),
 * SessionCard.tsx (the cards), DoneDrawer.tsx, SavedLane.tsx, swarmApi.ts (the
 * data), RosterMap.module.css.
 *
 * Prompt that produced it: "i am wanting it to be easy to see what is going on at
 * a glance in the observatory, so like which rooms, which sessions are open in
 * which rooms, how many need me, etc.. but i want to be able to click into each to
 * get more information." · "the left panel is too wide and the right panel is too
 * small and it's too much information at a glance"
 */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import type { TerrainData } from '../terrain/api';
import { FileRequests } from '../fileedit/FileRequests';
import { SudoRequests } from '../sudo/SudoRequests';
import type { RoomInfo, SessionMeta } from './api';
import { DoneDrawer } from './DoneDrawer';
import {
  helperConvs,
  narrowPlaces,
  placeRoster,
  roomCensus,
  sideGroups,
  stripLine,
  type MapProject,
  type MapRing,
  type MapRoom,
} from './mapPlaces';
import { orchestraRows } from './orchestra';
import { MapBody } from './RoomMap';
import { orderRoom, sessionPlace, swarmPaint, swarmView, unreadDone, type SwarmView } from './roomOrder';
import { SavedLane } from './SavedLane';
import { ApprovalCard, AwaitingCard, SessionCard } from './SessionCard';
import { cardState, isAsking, matchesAny, planSummary, type CardState, type RosterFilter } from './sessionFilters';
import laneStyles from './SessionLane.module.css';
import { ClosedSwarmsToggle, SwarmNetworkKey } from './SwarmNetwork';
import { shownSwarms, useClosedSwarmsShown, useRoomViews, useSwarms } from './swarmApi';
import { SwarmStack } from './SwarmStack';
import styles from './RosterMap.module.css';

/** What the cards on the right need from the page. */
interface CardActions {
  onOpen: (convId: string) => void;
  onSetRead: (convId: string, read: boolean) => void;
  onRename: (session: SessionMeta) => void;
  onChanged: () => void;
  onClose: (convId: string) => void;
}

/** What the right side is showing: what needs her, or one thing she clicked. */
type Detail =
  | { kind: 'needs' }
  | { kind: 'room'; room: string }
  | { kind: 'project'; id: string }
  | { kind: 'swarm'; id: number };

const TILE_PAINT = { needs_input: 'tileNeeds', plan: 'tilePlan', working: 'tileWorking', silent: '' } as const;

/** The dot on a session's line, the same colours its card would wear. */
const DOT_OF: Record<CardState, string> = {
  error: 'errorDot',
  running: 'liveDot',
  asking: 'readyDot',
  plan: 'planDot',
  unread: 'readyDot',
  recent: 'recentDot',
  rest: 'restDot',
};

/** Sentence-ish numbers for a heading: only the ones with something to say. */
function censusWords(place: MapRoom, opened: Record<string, string>): { open: number; needing: number; rest: string } {
  const { open, needing, running, done } = roomCensus(place);
  // A closing report she hasn't read still says so, though its card is a click away.
  const unread = unreadDone(place.done, opened);
  const doneWords = done > 0 ? `${done} done${unread > 0 ? ` (${unread} unread)` : ''}` : '';
  const rest = [running > 0 ? `${running} running` : '', doneWords].filter(Boolean).join(' · ');
  return { open, needing, rest };
}

/** One session on the overview: its dot and its name. Clicking opens it. */
function SessionLine({
  ring,
  meta,
  openedAt,
  onOpen,
}: {
  ring: MapRing;
  meta: SessionMeta | undefined;
  openedAt: string | undefined;
  onOpen: (convId: string) => void;
}) {
  const state: CardState = meta ? cardState(meta, openedAt) : 'rest';
  return (
    <button
      type="button"
      className={styles.line}
      onClick={() => onOpen(ring.conv)}
      {...agentPointerProps(ring.conv)}
      title={ring.summary ? `${ring.title} — ${ring.summary}` : ring.title}
    >
      <span className={laneStyles[DOT_OF[state]]} aria-hidden="true" />
      <span className={styles.lineTitle}>{ring.title}</span>
    </button>
  );
}

function SessionLines({
  rings,
  rosterById,
  opened,
  onOpen,
}: {
  rings: MapRing[];
  rosterById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  onOpen: (convId: string) => void;
}) {
  if (rings.length === 0) return null;
  return (
    <div className={styles.lines}>
      {rings.map((ring) => (
        <SessionLine key={ring.conv} ring={ring} meta={rosterById.get(ring.conv)} openedAt={opened[ring.conv]} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** A swarm in miniature: its members as dots round a centre dot, so it still
 * reads as a circle of agents without any of the lines and numbers. */
function MiniSwarm({ view }: { view: SwarmView }) {
  const { members } = view;
  const radius = 17;
  return (
    <svg width="48" height="48" viewBox="-24 -24 48 48" className={styles.mini} aria-hidden="true">
      <circle r={radius} className={styles.miniRing} />
      <circle r="3.5" className={styles.miniCentre} />
      {members.map((member, i) => {
        const angle = (i / members.length) * 2 * Math.PI - Math.PI / 2;
        return (
          <circle
            key={member.conv}
            cx={radius * Math.cos(angle)}
            cy={radius * Math.sin(angle)}
            r="3.5"
            className={styles[member.plan ? 'miniPlan' : `mini_${member.state}`]}
          />
        );
      })}
    </svg>
  );
}

/** One swarm on the overview: what it is and how many need her. Clicking reads
 * it on the right. */
function SwarmTile({ view, selected, onSelect }: { view: SwarmView; selected: boolean; onSelect: () => void }) {
  const paint = swarmPaint(view);
  const { needs_input: needing, working } = view.counts;
  return (
    <button
      type="button"
      className={[styles.tile, TILE_PAINT[paint] ? styles[TILE_PAINT[paint]] : '', selected ? styles.selected : '']
        .filter(Boolean)
        .join(' ')}
      aria-pressed={selected}
      onClick={onSelect}
      title={`Read ${view.swarm.name}`}
    >
      <MiniSwarm view={view} />
      <span className={styles.tileWords}>
        <span className={styles.tileName}>{view.swarm.name}</span>
        <span className={styles.numbers}>
          {needing > 0 ? <span className={styles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
          {working > 0 ? <span className={styles.working}>{working} running</span> : null}
          <span>{view.members.length} {view.members.length === 1 ? 'session' : 'sessions'}</span>
        </span>
      </span>
    </button>
  );
}

function SwarmTiles({
  views,
  detail,
  onDetail,
}: {
  views: SwarmView[];
  detail: Detail;
  onDetail: (next: Detail) => void;
}) {
  if (views.length === 0) return null;
  return (
    <div className={styles.tiles}>
      {views.map((view) => (
        <SwarmTile
          key={view.swarm.id}
          view={view}
          selected={detail.kind === 'swarm' && detail.id === view.swarm.id}
          onSelect={() => onDetail({ kind: 'swarm', id: view.swarm.id })}
        />
      ))}
    </div>
  );
}

/** One project room on the overview: a box with its name and numbers, holding
 * its tiles and lines. Clicking the name reads it on the right. */
function ProjectBox({
  box,
  detail,
  rosterById,
  opened,
  onOpen,
  onDetail,
}: {
  box: MapProject;
  detail: Detail;
  rosterById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  onOpen: (convId: string) => void;
  onDetail: (next: Detail) => void;
}) {
  const needing =
    box.swarms.reduce((total, view) => total + view.counts.needs_input, 0) +
    box.solos.filter((ring) => ring.state === 'needs_input').length;
  const selected = detail.kind === 'project' && detail.id === box.project.id;
  return (
    <div className={[styles.box, selected ? styles.selected : ''].filter(Boolean).join(' ')}>
      <button type="button" className={styles.boxHead} aria-pressed={selected} onClick={() => onDetail({ kind: 'project', id: box.project.id })}>
        <span className={styles.boxName}>{box.project.name}</span>
        {needing > 0 ? <span className={styles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
        <span className={styles.chevron} aria-hidden="true">&rsaquo;</span>
      </button>
      <SwarmTiles views={box.swarms} detail={detail} onDetail={onDetail} />
      <SessionLines rings={box.solos} rosterById={rosterById} opened={opened} onOpen={onOpen} />
    </div>
  );
}

/** One room on the overview. Its heading is the glance: how many are open, how
 * many need her, how many run. Clicking it reads the room on the right. */
function RoomSection({
  place,
  whole,
  heading,
  detail,
  rosterById,
  opened,
  filtering,
  onOpen,
  onNew,
  onDetail,
}: {
  place: MapRoom;
  /** The room before any filter: its heading's numbers stay the room's own. */
  whole: MapRoom;
  heading: string;
  detail: Detail;
  rosterById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  filtering: boolean;
  onOpen: (convId: string) => void;
  onNew: () => void;
  onDetail: (next: Detail) => void;
}) {
  const { open, needing, rest } = censusWords(whole, opened);
  const selected = detail.kind === 'room' && detail.room === place.room;
  const rings = [...place.solos, ...place.others];
  const empty = place.swarms.length + place.projects.length + rings.length === 0;
  return (
    <section className={styles.room} aria-label={heading}>
      <div className={styles.roomHead}>
        <button
          type="button"
          className={[styles.roomButton, selected ? styles.selected : ''].filter(Boolean).join(' ')}
          aria-pressed={selected}
          onClick={() => onDetail({ kind: 'room', room: place.room })}
          title={`Read everything in ${heading}`}
        >
          <h2 className={styles.roomName}>{heading}</h2>
          <span className={styles.numbers}>
            <span>{open} open</span>
            {needing > 0 ? <span className={styles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
            {rest ? <span>{rest}</span> : null}
          </span>
          <span className={styles.chevron} aria-hidden="true">&rsaquo;</span>
        </button>
        <button type="button" className={styles.roomNew} onClick={onNew} title={`New session in ${heading}`} aria-label={`New session in ${heading}`}>
          +
        </button>
      </div>
      {place.projects.map((box) => (
        <ProjectBox key={box.project.id} box={box} detail={detail} rosterById={rosterById} opened={opened} onOpen={onOpen} onDetail={onDetail} />
      ))}
      <SwarmTiles views={place.swarms} detail={detail} onDetail={onDetail} />
      <SessionLines rings={rings} rosterById={rosterById} opened={opened} onOpen={onOpen} />
      {empty ? (
        <p className={styles.note}>
          {filtering ? 'Nothing in this room matches those filters.' : 'Nothing open here. Tap + to start one.'}
        </p>
      ) : null}
    </section>
  );
}

/** A reply she hasn't read: quieter than a card, one tap to open or to mark read. */
function ToReadRow({ meta, onOpen, onSetRead }: { meta: SessionMeta; onOpen: (convId: string) => void; onSetRead: (convId: string, read: boolean) => void }) {
  const title = meta.title || meta.id;
  return (
    <div className={styles.readRow} {...agentPointerProps(meta.id)}>
      <button type="button" className={styles.readOpen} onClick={() => onOpen(meta.id)} title="Open this session">
        <span className={styles.readTitle}>{title}</span>
        {meta.summary ? <span className={styles.readSummary}>{meta.summary}</span> : null}
      </button>
      <button
        type="button"
        className={laneStyles.readBtn}
        aria-label={`Mark ${title} read`}
        title="Mark as read"
        onClick={() => onSetRead(meta.id, true)}
      >
        <span className={[laneStyles.readDot, laneStyles.readDotUnread].join(' ')} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Draw sessions as their full cards: a question, a command to approve, or the
 * ordinary card. The same three a room draws (SessionLane.tsx). */
function useCards(sessions: SessionMeta[], opened: Record<string, string>, terrain: TerrainData | undefined, actions: CardActions) {
  const { onOpen, onSetRead, onRename, onChanged, onClose } = actions;
  const rows = new Map(orchestraRows(sessions, terrain).map((row) => [row.id, row]));
  const live = sessions.some((s) => s.running);
  return (meta: SessionMeta) => {
    const row = rows.get(meta.id);
    if (!row) return null;
    if (row.pendingApproval) return <ApprovalCard key={meta.id} row={row} onOpen={onOpen} onChanged={onChanged} />;
    if (isAsking(meta)) {
      return <AwaitingCard key={meta.id} row={row} planLine={planSummary(meta)} onOpen={onOpen} onChanged={onChanged} />;
    }
    return (
      <SessionCard
        key={meta.id}
        row={row}
        meta={meta}
        openedAt={opened[meta.id]}
        live={live}
        onOpen={onOpen}
        onSetRead={onSetRead}
        onRename={onRename}
        onClose={onClose}
        onChanged={onChanged}
      />
    );
  };
}

/** What the right side opens on: everything that wants her, in the room's order. */
function NeedsYou({
  sessions,
  saved,
  opened,
  helpers,
  filtering,
  matchesMeta,
  terrain,
  actions,
}: {
  sessions: SessionMeta[];
  saved: SessionMeta[];
  opened: Record<string, string>;
  helpers: ReadonlySet<string>;
  filtering: boolean;
  matchesMeta: ((meta: SessionMeta) => boolean) | null;
  terrain: TerrainData | undefined;
  actions: CardActions;
}) {
  const groups = sideGroups(sessions, opened, helpers, matchesMeta);
  const card = useCards([...groups.asking, ...groups.plans, ...groups.errors, ...groups.rest], opened, terrain, actions);
  const nothing =
    groups.asking.length + groups.plans.length + groups.errors.length + groups.toRead.length + groups.rest.length === 0;
  return (
    <>
      <SudoRequests />
      <FileRequests />
      {groups.asking.length > 0 ? <div className={styles.group}>{groups.asking.map(card)}</div> : null}
      {groups.plans.length > 0 ? <div className={styles.group}>{groups.plans.map(card)}</div> : null}
      {groups.errors.length > 0 ? <div className={styles.group}>{groups.errors.map(card)}</div> : null}
      {groups.toRead.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupHead}>To read</h3>
          {groups.toRead.map((meta) => (
            <ToReadRow key={meta.id} meta={meta} onOpen={actions.onOpen} onSetRead={actions.onSetRead} />
          ))}
        </div>
      ) : null}
      {groups.rest.length > 0 ? <div className={styles.group}>{groups.rest.map(card)}</div> : null}
      {nothing ? (
        <p className={styles.note}>{filtering ? 'No sessions match those filters.' : 'Nothing is waiting on you.'}</p>
      ) : null}
      {filtering ? null : <SavedLane sessions={saved} onOpen={actions.onOpen} onChanged={actions.onChanged} />}
    </>
  );
}

/** A room's whole story on the right: its sessions as cards, what's closing, the
 * swarms it has closed, and the way back through its past. */
function RoomDetail({
  place,
  heading,
  rosterById,
  opened,
  terrain,
  actions,
}: {
  place: MapRoom;
  heading: string;
  rosterById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  terrain: TerrainData | undefined;
  actions: CardActions;
}) {
  const navigate = useNavigate();
  const metas = [...place.solos, ...place.others].flatMap((ring) => rosterById.get(ring.conv) ?? []);
  const ordered = orderRoom(metas.map((meta) => ({ item: meta, ...sessionPlace(meta, opened[meta.id]) })));
  const card = useCards([...ordered, ...place.done], opened, terrain, actions);
  return (
    <>
      <h3 className={styles.detailName}>{heading}</h3>
      {ordered.length > 0 ? <div className={styles.group}>{ordered.map(card)}</div> : (
        <p className={styles.note}>Every open session here is in a swarm or a project room.</p>
      )}
      {place.done.length > 0 ? (
        <DoneDrawer laneKey={place.room} count={place.done.length} unread={unreadDone(place.done, opened)}>
          {place.done.map(card)}
        </DoneDrawer>
      ) : null}
      <ClosedSwarmsToggle closedCount={place.closedCount} />
      <button
        type="button"
        className={styles.pastLink}
        onClick={() => void navigate({ to: '/observatory/archive', search: { lane: place.room } })}
      >
        Past sessions in {heading} &rarr;
      </button>
    </>
  );
}

export function RosterMap({
  size,
  band,
  controls,
  doors,
  rooms,
  roomable,
  rosterById,
  saved,
  opened,
  filters,
  terrain,
  stray,
  onNew,
  ...actions
}: CardActions & {
  /** 'wide' has room for both sides; 'strip' shows a one-line stand-in for the right. */
  size: 'wide' | 'strip';
  band: ReactNode;
  /** The row with the '+', the filters, the sort, search, Keeper and meter. */
  controls: ReactNode;
  /** The slim doors for the foot. */
  doors: ReactNode;
  /** The rooms, in the order to draw them. */
  rooms: RoomInfo[];
  /** roomRoster's list: the sessions the overview places. */
  roomable: SessionMeta[];
  rosterById: Map<string, SessionMeta>;
  saved: SessionMeta[];
  opened: Record<string, string>;
  filters: RosterFilter[];
  terrain: TerrainData | undefined;
  stray: string | null;
  onNew: (room: string) => void;
}) {
  const { onOpen, onChanged } = actions;
  const { data: allSwarms } = useSwarms();
  const showClosed = useClosedSwarmsShown();
  const roomIds = rooms.map((room) => room.id as string);
  const roomViews = useRoomViews(roomIds);
  const swarms = allSwarms ?? [];
  const views = shownSwarms(swarms, showClosed).map((s) => swarmView(s, rosterById, opened));
  const helpers = helperConvs(swarms, roomViews);

  // What the pressed filters let through: one test, read by both sides.
  const filtering = filters.length > 0;
  const matchesMeta = filtering ? (meta: SessionMeta) => matchesAny(meta, opened[meta.id], filters) : null;
  const matchesConv = matchesMeta
    ? (conv: string) => {
        const meta = rosterById.get(conv);
        return meta !== undefined && matchesMeta(meta);
      }
    : null;

  const everywhere = placeRoster({ rooms: roomIds, stray, sessions: roomable, views, swarms, roomViews });
  const places = matchesConv ? narrowPlaces(everywhere, matchesConv) : everywhere;
  const headingOf = (room: string) => rooms.find((candidate) => candidate.id === room)?.name ?? room;

  // What the right side shows. On a narrower panel it only shows while she has it
  // open, in place of the overview. Something clicked that's since gone from the
  // page drops back to what needs her.
  const [detail, setDetail] = useState<Detail>({ kind: 'needs' });
  const [listOpen, setListOpen] = useState(false);
  const showDetail = (next: Detail) => {
    setDetail(next);
    setListOpen(true);
  };
  const swarmDetail = detail.kind === 'swarm' ? (views.find((view) => view.swarm.id === detail.id) ?? null) : null;
  const projectDetail =
    detail.kind === 'project'
      ? (everywhere.flatMap((place) => place.projects).find((box) => box.project.id === detail.id) ?? null)
      : null;
  const roomDetail = detail.kind === 'room' ? (everywhere.find((place) => place.room === detail.room) ?? null) : null;
  const onDetailPage = swarmDetail !== null || projectDetail !== null || roomDetail !== null;

  const needsGroups = sideGroups(roomable, opened, helpers, null);
  const rightShowing = size === 'wide' || listOpen;

  const right = (
    <div className={styles.right}>
      {onDetailPage ? (
        <button type="button" className={styles.back} onClick={() => setDetail({ kind: 'needs' })}>
          &larr; What needs you
        </button>
      ) : null}
      {swarmDetail ? (
        <div className={styles.swarmDetail}>
          <SwarmStack view={swarmDetail} rosterById={rosterById} onOpen={onOpen} onChanged={onChanged} />
          <SwarmNetworkKey />
        </div>
      ) : projectDetail ? (
        <>
          <h3 className={styles.detailName}>{projectDetail.project.name}</h3>
          <div className={styles.projectBody}>
            <MapBody
              helperConv={projectDetail.project.helper_conv}
              helperLabel="Project helper"
              moves={projectDetail.project.moves}
              solos={projectDetail.project.solos}
              swarms={projectDetail.swarms}
              rosterById={rosterById}
              onOpen={onOpen}
              onChanged={onChanged}
              emptySwarms={`No swarms in ${projectDetail.project.name} right now.`}
            />
          </div>
          <Link to="/observatory/project/$projectId" params={{ projectId: projectDetail.project.id }} className={styles.pastLink}>
            Open the {projectDetail.project.name} page &rarr;
          </Link>
        </>
      ) : roomDetail ? (
        <RoomDetail
          place={roomDetail}
          heading={headingOf(roomDetail.room)}
          rosterById={rosterById}
          opened={opened}
          terrain={terrain}
          actions={actions}
        />
      ) : (
        <NeedsYou
          sessions={roomable}
          saved={saved}
          opened={opened}
          helpers={helpers}
          filtering={filtering}
          matchesMeta={matchesMeta}
          terrain={terrain}
          actions={actions}
        />
      )}
    </div>
  );

  return (
    <div className={styles.page}>
      {band}
      {controls}
      {size === 'strip' ? (
        <button type="button" className={styles.strip} aria-expanded={listOpen} onClick={() => setListOpen((was) => !was)}>
          <span className={styles.stripLine}>{stripLine(needsGroups)}</span>
          <span aria-hidden="true">{listOpen ? 'Back to the overview' : 'Open the list'}</span>
        </button>
      ) : null}
      <div className={[styles.main, size === 'wide' ? styles.mainWide : ''].filter(Boolean).join(' ')}>
        {/* The overview stays mounted behind the detail, so coming back finds it where it was. */}
        <div className={styles.overview} style={size === 'strip' && listOpen ? { display: 'none' } : undefined}>
          {places.map((place, i) => (
            <RoomSection
              key={place.room}
              place={place}
              whole={everywhere[i]}
              heading={headingOf(place.room)}
              detail={detail}
              rosterById={rosterById}
              opened={opened}
              filtering={filtering}
              onOpen={onOpen}
              onNew={() => onNew(place.room)}
              onDetail={showDetail}
            />
          ))}
        </div>
        {rightShowing ? right : null}
      </div>
      <nav className={styles.foot} aria-label="Other rooms">
        {doors}
      </nav>
    </div>
  );
}
