/**
 * RosterMap.tsx — the Observatory on a desktop: the rooms as a map, with a side
 * column for what wants her, instead of one long column of cards.
 *
 * What this is, in plain English, top to bottom:
 *
 *   - the room helper's band, then a row with the title, the search box, a small
 *     door to the Keeper and the memory meter, then a row with the '+', the
 *     filters and the sort. RosterPage hands these in; they don't scroll.
 *   - LEFT, filling the space, the map: each room with its heading and '+'. Each
 *     swarm is a circle (SwarmNetwork, as on its own page), each session working
 *     alone a ring, and each project room a collapsible box of its own circles
 *     and rings. Tap a ring to open that session, in the pane on the right
 *     (shell/panels/conversationRouting.ts). Tap a circle's name or its empty
 *     space to read that swarm in the side column.
 *   - RIGHT, the side column: sudo and file requests, then the question and
 *     approval cards, plans waiting on her go, failed turns, a quieter list of
 *     replies to read, then the Done drawers and Saved for later, shut. The
 *     question cards live only here on this view; a swarm's circle says how many
 *     need her and wears an orange ring.
 *   - the FOOT: one slim row of doors to the other rooms and the rooms' past
 *     sessions, stopping short of the notes pill's corner.
 *
 * Each column scrolls by itself; the page as a whole doesn't. On a narrower panel
 * (RosterPage decides by measuring it) the side column gives way to a one-line
 * strip, "3 need you · 2 plans", and tapping that swaps the map for the list.
 *
 * With filters down, the map hides circles, boxes and rings with no match and
 * dims the non-matching rings in the circles that stay; the side column narrows
 * to the matching sessions. Where each session stands, and what the filters do to
 * that, is mapPlaces.ts (tested); this file only draws it.
 *
 * Touches: RosterPage.tsx (owns the state, draws this), mapPlaces.ts, RoomMap.tsx
 * (Ring, stateOf, moveLine), SwarmStack.tsx (a swarm in the side column),
 * SwarmNetwork.tsx (the circles), SessionCard.tsx (the cards), DoneDrawer.tsx,
 * SavedLane.tsx, swarmApi.ts (the data), RosterMap.module.css.
 *
 * Prompt that produced it: "it needs to have a better dashboard UI, rather than
 * like the easy scroll UI on desktop." She chose a map first, "but with like, the
 * ability to filter by planning or needs you sessions".
 */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import { CollapsibleCard } from '../body/CollapsibleCard';
import type { TerrainData } from '../terrain/api';
import { FileRequests } from '../fileedit/FileRequests';
import { SudoRequests } from '../sudo/SudoRequests';
import type { RoomInfo, SessionMeta } from './api';
import { DoneDrawer } from './DoneDrawer';
import { LaneHead, useLaneOpen } from './LaneHead';
import {
  helperConvs,
  narrowPlaces,
  placeRoster,
  sideGroups,
  stripLine,
  type MapProject,
  type MapRing,
  type MapRoom,
} from './mapPlaces';
import { orchestraRows } from './orchestra';
import { moveLine, Ring, stateOf } from './RoomMap';
import { swarmPaint, swarmView, unreadDone, type SwarmView } from './roomOrder';
import { SavedLane } from './SavedLane';
import { ApprovalCard, AwaitingCard, SessionCard } from './SessionCard';
import { matchesAny, planSummary, type RosterFilter } from './sessionFilters';
import laneStyles from './SessionLane.module.css';
import { ClosedSwarmsToggle, SwarmNetwork, SwarmNetworkKey } from './SwarmNetwork';
import { shownSwarms, useClosedSwarmsShown, useRoomViews, useSwarms } from './swarmApi';
import { shortTitle } from './swarmNetworkMath';
import { SwarmStack } from './SwarmStack';
import roomStyles from './RoomMap.module.css';
import ring from './SwarmNetwork.module.css';
import styles from './RosterMap.module.css';

/** What the cards in the side column need from the page. */
interface CardActions {
  onOpen: (convId: string) => void;
  onSetRead: (convId: string, read: boolean) => void;
  onRename: (session: SessionMeta) => void;
  onChanged: () => void;
  onClose: (convId: string) => void;
}

const CIRCLE_PAINT = { needs_input: 'circleNeeds', plan: 'circlePlan', working: 'circleWorking', silent: '' } as const;
const DOT_PAINT = { needs_input: 'readyDot', plan: 'planDot', working: 'liveDot', silent: 'restDot' } as const;

/** One session as a ring and its name; tap to open it. */
function MapRingButton({ item, onOpen, live }: { item: MapRing; onOpen: (convId: string) => void; live?: SessionMeta }) {
  const state = stateOf(live, item.state);
  return (
    <button
      type="button"
      className={[roomStyles.agent, ring[`state_${state}`]].join(' ')}
      onClick={() => onOpen(item.conv)}
      {...agentPointerProps(item.conv)}
      title={item.summary ? `${item.title} — ${item.summary}` : item.title}
    >
      <Ring state={state} />
      <span className={roomStyles.agentName}>{shortTitle(item.title)}</span>
    </button>
  );
}

/** One swarm as a circle: its name and counts over its network. The name and the
 * circle's empty space read the swarm in the side column; a ring opens a session
 * and a line opens its messages, as on the swarm's own page. */
function MapCircle({
  view,
  selected,
  rosterById,
  onOpen,
  onSelect,
  dimmed,
}: {
  view: SwarmView;
  selected: boolean;
  rosterById: Map<string, SessionMeta>;
  onOpen: (convId: string) => void;
  onSelect: (swarmId: number) => void;
  dimmed?: ReadonlySet<string>;
}) {
  const { swarm, counts } = view;
  const paint = swarmPaint(view);
  return (
    <div className={[styles.swarm, selected ? styles.swarmSelected : ''].filter(Boolean).join(' ')}>
      <button type="button" className={styles.swarmName} onClick={() => onSelect(swarm.id)} title={`Read ${swarm.name}`}>
        <span className={laneStyles[DOT_PAINT[paint]]} aria-hidden="true" />
        <span className={styles.swarmNameText}>{swarm.name}</span>
      </button>
      <div className={styles.swarmCounts}>
        {counts.needs_input > 0 ? <span className={styles.needing}>{counts.needs_input} need{counts.needs_input === 1 ? 's' : ''} you</span> : null}
        {view.plans > 0 ? <span className={styles.working}>{view.plans} plan{view.plans === 1 ? '' : 's'}</span> : null}
        {counts.working > 0 ? <span className={styles.working}>{counts.working} working</span> : null}
        <span>{view.members.length} {view.members.length === 1 ? 'session' : 'sessions'}</span>
      </div>
      {/* Only empty space selects: anything drawn inside answers for itself. A
          sheet opened from a line isn't inside this box in the page, only in
          React's tree, which is what the contains check rules out. */}
      <div
        className={[styles.circle, CIRCLE_PAINT[paint] ? styles[CIRCLE_PAINT[paint]] : ''].filter(Boolean).join(' ')}
        onClick={(event) => {
          const target = event.target as Element;
          if (!event.currentTarget.contains(target) || target.closest('button')) return;
          if (target.tagName === 'line' || target.tagName === 'polygon') return;
          onSelect(swarm.id);
        }}
      >
        <SwarmNetwork
          swarm={swarm}
          onOpen={onOpen}
          helperWorking={!!(swarm.helper_conv && rosterById.get(swarm.helper_conv)?.running)}
          round
          dimmed={dimmed}
        />
      </div>
    </div>
  );
}

/** The agents in these swarms a filter doesn't match, to draw stepped back. */
function dimmedIn(views: SwarmView[], matches: ((conv: string) => boolean) | null): ReadonlySet<string> | undefined {
  if (!matches) return undefined;
  return new Set(views.flatMap((view) => view.swarm.members.map((m) => m.conv)).filter((conv) => !matches(conv)));
}

function Circles({
  views,
  selected,
  rosterById,
  onOpen,
  onSelect,
  matches,
}: {
  views: SwarmView[];
  selected: number | null;
  rosterById: Map<string, SessionMeta>;
  onOpen: (convId: string) => void;
  onSelect: (swarmId: number) => void;
  matches: ((conv: string) => boolean) | null;
}) {
  if (views.length === 0) return null;
  const dimmed = dimmedIn(views, matches);
  return (
    <div className={styles.circles}>
      {views.map((view) => (
        <MapCircle
          key={view.swarm.id}
          view={view}
          selected={selected === view.swarm.id}
          rosterById={rosterById}
          onOpen={onOpen}
          onSelect={onSelect}
          dimmed={dimmed}
        />
      ))}
    </div>
  );
}

function Rings({
  heading,
  items,
  rosterById,
  onOpen,
}: {
  heading: string;
  items: MapRing[];
  rosterById: Map<string, SessionMeta>;
  onOpen: (convId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h4 className={roomStyles.soloHead}>{heading}</h4>
      <div className={roomStyles.solos}>
        {items.map((item) => (
          <MapRingButton key={item.conv} item={item} live={rosterById.get(item.conv)} onOpen={onOpen} />
        ))}
      </div>
    </>
  );
}

/** How many in these swarms and rings need her, for a title line. */
function needingIn(views: SwarmView[], rings: MapRing[]): number {
  return (
    views.reduce((total, view) => total + view.counts.needs_input, 0) +
    rings.filter((item) => item.state === 'needs_input').length
  );
}

/** One project room as a box: its helper's dot, its circles and rings, and the
 * way to its own page. Shut or open as she left it, in the same memory as the
 * column's box. */
function ProjectBox({
  box,
  selected,
  rosterById,
  onOpen,
  onSelect,
  matches,
}: {
  box: MapProject;
  selected: number | null;
  rosterById: Map<string, SessionMeta>;
  onOpen: (convId: string) => void;
  onSelect: (swarmId: number) => void;
  matches: ((conv: string) => boolean) | null;
}) {
  const { project, swarms, solos } = box;
  const needing = needingIn(swarms, solos);
  const helperMeta = project.helper_conv ? rosterById.get(project.helper_conv) : undefined;
  const lastMove = project.moves.find((move) => !move.undone_at);
  const helperState = stateOf(helperMeta, 'silent');
  return (
    <CollapsibleCard
      cardKey={`project-room-${project.id}`}
      title={`${project.name} — project room`}
      defaultOpen
      note={needing > 0 ? `${needing} need${needing === 1 ? 's' : ''} you` : undefined}
      classes={{ note: roomStyles.titleNote }}
    >
      <div className={roomStyles.map}>
        {project.helper_conv ? (
          <div className={styles.helperRow}>
            <button
              type="button"
              className={[roomStyles.agent, roomStyles.roomHelper, ring[`state_${helperState}`]].join(' ')}
              onClick={() => onOpen(project.helper_conv!)}
              {...agentPointerProps(project.helper_conv)}
              title="The project helper — tap to open its chat"
            >
              <Ring state={helperState} big />
              <span className={roomStyles.agentName}>Project helper</span>
            </button>
            {lastMove ? <p className={styles.helperMove}>Last move: {moveLine(lastMove)}</p> : null}
          </div>
        ) : null}
        <Circles views={swarms} selected={selected} rosterById={rosterById} onOpen={onOpen} onSelect={onSelect} matches={matches} />
        <Rings heading="Working alone" items={solos} rosterById={rosterById} onOpen={onOpen} />
        <Link to="/observatory/project/$projectId" params={{ projectId: project.id }} className={roomStyles.projectLink}>
          Open the {project.name} page
        </Link>
      </div>
    </CollapsibleCard>
  );
}

/** One room on the map: its heading and '+', its boxes, circles and rings. The
 * heading keeps the room's census, so shutting it can't hide a question. */
function MapRoomSection({
  place,
  heading,
  selected,
  rosterById,
  filtering,
  matches,
  onOpen,
  onNew,
  onSelect,
}: {
  place: MapRoom;
  heading: string;
  selected: number | null;
  rosterById: Map<string, SessionMeta>;
  filtering: boolean;
  matches: ((conv: string) => boolean) | null;
  onOpen: (convId: string) => void;
  onNew: () => void;
  onSelect: (swarmId: number) => void;
}) {
  const [open, toggle] = useLaneOpen(`map:${place.room}`);
  const projectViews = place.projects.flatMap((box) => box.swarms);
  const projectRings = place.projects.flatMap((box) => box.solos);
  const needing = needingIn([...place.swarms, ...projectViews], [...place.solos, ...place.others, ...projectRings]);
  const empty = place.swarms.length + place.projects.length + place.solos.length + place.others.length === 0;
  return (
    <section className={styles.room} aria-label={heading}>
      <LaneHead heading={heading} open={open} onToggle={toggle} wanting={needing > 0} onNew={onNew}>
        {needing > 0 ? <span className={laneStyles.waitCount}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
      </LaneHead>
      {open ? (
        <div className={styles.roomBody}>
          {place.projects.map((box) => (
            <ProjectBox
              key={box.project.id}
              box={box}
              selected={selected}
              rosterById={rosterById}
              onOpen={onOpen}
              onSelect={onSelect}
              matches={matches}
            />
          ))}
          <Circles views={place.swarms} selected={selected} rosterById={rosterById} onOpen={onOpen} onSelect={onSelect} matches={matches} />
          <Rings heading="Working alone" items={place.solos} rosterById={rosterById} onOpen={onOpen} />
          <Rings heading="Other sessions" items={place.others} rosterById={rosterById} onOpen={onOpen} />
          {empty ? (
            <p className={roomStyles.note}>
              {filtering ? 'Nothing in this room matches those filters.' : 'Nothing here yet — tap + beside the heading to start one.'}
            </p>
          ) : null}
          {filtering ? null : <ClosedSwarmsToggle closedCount={place.closedCount} />}
        </div>
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

/** The side column's list: everything that wants her, in order, then the shut
 * Done drawers and Saved for later. */
function SideList({
  sessions,
  places,
  headingOf,
  saved,
  opened,
  helpers,
  filtering,
  matchesMeta,
  terrain,
  actions,
}: {
  sessions: SessionMeta[];
  places: MapRoom[];
  headingOf: (room: string) => string;
  saved: SessionMeta[];
  opened: Record<string, string>;
  helpers: ReadonlySet<string>;
  filtering: boolean;
  matchesMeta: ((meta: SessionMeta) => boolean) | null;
  terrain: TerrainData | undefined;
  actions: CardActions;
}) {
  const { onOpen, onSetRead, onRename, onChanged, onClose } = actions;
  const groups = sideGroups(sessions, opened, helpers, matchesMeta);
  const doneSessions = places.flatMap((place) => place.done);
  const rows = new Map(
    orchestraRows([...groups.asking, ...groups.plans, ...groups.errors, ...groups.rest, ...doneSessions], terrain).map((row) => [row.id, row]),
  );
  const anyRunning = sessions.some((s) => s.running);
  const card = (meta: SessionMeta) => {
    const row = rows.get(meta.id);
    return row ? (
      <SessionCard
        key={meta.id}
        row={row}
        meta={meta}
        openedAt={opened[meta.id]}
        live={anyRunning}
        onOpen={onOpen}
        onSetRead={onSetRead}
        onRename={onRename}
        onClose={onClose}
        onChanged={onChanged}
      />
    ) : null;
  };
  const nothing =
    groups.asking.length + groups.plans.length + groups.errors.length + groups.toRead.length + groups.rest.length === 0;
  return (
    <>
      <SudoRequests />
      <FileRequests />
      {groups.asking.length > 0 ? (
        <div className={styles.group}>
          {groups.asking.map((meta) => {
            const row = rows.get(meta.id);
            if (!row) return null;
            return row.pendingApproval ? (
              <ApprovalCard key={meta.id} row={row} onOpen={onOpen} onChanged={onChanged} />
            ) : (
              <AwaitingCard key={meta.id} row={row} planLine={planSummary(meta)} onOpen={onOpen} onChanged={onChanged} />
            );
          })}
        </div>
      ) : null}
      {groups.plans.length > 0 ? <div className={styles.group}>{groups.plans.map(card)}</div> : null}
      {groups.errors.length > 0 ? <div className={styles.group}>{groups.errors.map(card)}</div> : null}
      {groups.toRead.length > 0 ? (
        <div className={styles.group}>
          <h4 className={styles.groupHead}>To read</h4>
          {groups.toRead.map((meta) => (
            <ToReadRow key={meta.id} meta={meta} onOpen={onOpen} onSetRead={onSetRead} />
          ))}
        </div>
      ) : null}
      {groups.rest.length > 0 ? <div className={styles.group}>{groups.rest.map(card)}</div> : null}
      {nothing ? (
        <p className={styles.sideNote}>{filtering ? 'No sessions match those filters.' : 'Nothing is waiting on you.'}</p>
      ) : null}
      {places.map((place) =>
        place.done.length > 0 ? (
          <DoneDrawer
            key={place.room}
            laneKey={place.room}
            count={place.done.length}
            unread={unreadDone(place.done, opened)}
            roomName={headingOf(place.room)}
          >
            {place.done.map(card)}
          </DoneDrawer>
        ) : null,
      )}
      {filtering ? null : <SavedLane sessions={saved} onOpen={onOpen} onChanged={onChanged} />}
    </>
  );
}

export function RosterMap({
  size,
  band,
  title,
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
  /** 'wide' has room for the side column; 'strip' shows its one-line stand-in. */
  size: 'wide' | 'strip';
  band: ReactNode;
  /** The row with the title, the search box, the Keeper's door, the meter. */
  title: ReactNode;
  /** The row with the '+', the filters and the sort. */
  controls: ReactNode;
  /** The slim doors for the foot. */
  doors: ReactNode;
  /** The rooms, in the order the map draws them. */
  rooms: RoomInfo[];
  /** roomRoster's list: the sessions the map places. */
  roomable: SessionMeta[];
  rosterById: Map<string, SessionMeta>;
  saved: SessionMeta[];
  opened: Record<string, string>;
  filters: RosterFilter[];
  terrain: TerrainData | undefined;
  stray: string | null;
  onNew: (room: string) => void;
}) {
  const navigate = useNavigate();
  const { onOpen, onChanged } = actions;
  const { data: allSwarms } = useSwarms();
  const showClosed = useClosedSwarmsShown();
  const roomIds = rooms.map((room) => room.id as string);
  const roomViews = useRoomViews(roomIds);
  const swarms = allSwarms ?? [];
  const views = shownSwarms(swarms, showClosed).map((s) => swarmView(s, rosterById, opened));
  const helpers = helperConvs(swarms, roomViews);

  // What the pressed filters let through: one test, read by the map and the list.
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

  // The side column shows either the list or one swarm, chosen by tapping its
  // circle. A swarm that has gone from the page drops back to the list. On a
  // narrower map the column is only there while she has it open.
  const [selected, setSelected] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const selectedView = views.find((view) => view.swarm.id === selected) ?? null;
  const selectSwarm = (swarmId: number) => {
    setSelected(swarmId);
    setListOpen(true);
  };
  const sideShowing = size === 'wide' || listOpen;

  const side = (
    <div className={styles.side}>
      {selectedView ? (
        <>
          <button type="button" className={styles.back} onClick={() => setSelected(null)}>
            &larr; Everything waiting
          </button>
          <SwarmStack view={selectedView} rosterById={rosterById} onOpen={onOpen} onChanged={onChanged} hideBubble />
        </>
      ) : (
        <SideList
          sessions={roomable}
          places={places}
          headingOf={headingOf}
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
      {title}
      {controls}
      {size === 'strip' ? (
        <button type="button" className={styles.strip} aria-expanded={listOpen} onClick={() => setListOpen((was) => !was)}>
          <span className={styles.stripLine}>{stripLine(sideGroups(roomable, opened, helpers, null))}</span>
          <span aria-hidden="true">{listOpen ? 'Back to the map' : 'Open the list'}</span>
        </button>
      ) : null}
      <div className={[styles.main, size === 'wide' ? styles.mainWide : ''].filter(Boolean).join(' ')}>
        {/* The map stays mounted behind the list, so coming back finds it where it was. */}
        <div className={styles.map} style={size === 'strip' && listOpen ? { display: 'none' } : undefined}>
          {places.map((place) => (
            <MapRoomSection
              key={place.room}
              place={place}
              heading={headingOf(place.room)}
              selected={selected}
              rosterById={rosterById}
              filtering={filtering}
              matches={matchesConv}
              onOpen={onOpen}
              onNew={() => onNew(place.room)}
              onSelect={selectSwarm}
            />
          ))}
          {views.length > 0 ? <SwarmNetworkKey /> : null}
        </div>
        {sideShowing ? side : null}
      </div>
      <nav className={styles.foot} aria-label="Other rooms">
        {doors}
        {rooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className={styles.pastLink}
            onClick={() => void navigate({ to: '/observatory/archive', search: { lane: room.id } })}
          >
            Past sessions in {room.name}
          </button>
        ))}
      </nav>
    </div>
  );
}
