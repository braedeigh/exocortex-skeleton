/**
 * RoomMap.tsx — a room seen from above: every swarm as a circle, the helpers
 * in the middle, and the sessions working alone in rows underneath.
 *
 * What this is, in plain English: at the head of a room that has a room
 * helper (room_helper.py — the Coding room, for now), a collapsible card
 * draws the whole room at once:
 *
 *   - the ROOM HELPER, a filled dot like a swarm helper's: it sits a layer
 *     above the swarms and decides who works together. Tap it to open its chat,
 *     where every move it makes is posted with its reason and an undo line. On
 *     the Observatory page it's in the band at the top instead
 *     (RoomHelperBand.tsx), so this map leaves it out (`helperInBand`);
 *   - each SWARM as one stack (SwarmStack.tsx): its name and the helper's
 *     summary, then its circle drawn exactly as on its own page
 *     (SwarmNetwork.tsx), then the questions its members are asking her as
 *     answerable cards, then a little card per member. Each stack folds
 *     down to its name and counts from a chevron at its top, remembered
 *     per swarm. The swarms stand in
 *     the room's order, so one with a question comes first
 *     (roomOrder.orderRoom). SessionLane doesn't also give them a swarm card;
 *     this is the one place a swarm shows in the room;
 *   - a switch to show the CLOSED swarms (fewer than two sessions still at work), hidden
 *     otherwise — only there when some are closed;
 *   - every session WORKING ALONE (in no swarm) in rows beneath, as the same
 *     rings, so a glance says who's out on their own.
 *
 * Each PROJECT ROOM inside the room (project_rooms.py — a build switched on
 * as its own room, like a repo of its own) is one collapsible box, shut or
 * open as she left it: its project helper's dot on top, then its own swarm
 * stacks and its own sessions working alone, and a link to its page
 * (/observatory/project/<id>, ProjectPage.tsx, which draws the same box
 * whole). Those swarms and sessions are in the box, not in the room's own
 * rows. The room's own swarms and solos stay as they were.
 *
 * A ring's state follows the roster where the page has it (working glows,
 * an orange ring when it needs her), falling back to what the server said.
 * Tap any ring to open that session. Pointing the mouse at one lights that
 * agent's orb on the Terrain map, when the map is open in another tile
 * (shell/panels/agentHoverBus.ts).
 *
 * When the card is shut, its title line still says how many swarm members
 * need her, so a question can't hide behind the collapse.
 *
 * Touches: swarmApi.ts (useRoomView — routes/swarms.py `room`, with its
 * `projects`), SwarmStack.tsx
 * (each swarm), SwarmNetwork.tsx (the key, the closed switch, and the rings'
 * look via SwarmNetwork.module.css), roomOrder.ts (the swarms' order),
 * body/CollapsibleCard.tsx (the card), RoomMap.module.css, SessionLane.tsx (which
 * puts this at the head of the room).
 *
 * Prompt that produced it: "There should also be a display on the front with
 * circles for each swarm and the generated helpers in the middle and extra
 * agents in rows below that. The swarms will be in the circles like they are
 * on each page." · "i want the summary of the swarm above the little bubble
 * and then i want the question cards to show below it in the swarm and i want
 * each one to have its little card below the swarm bubble"
 */
import { Link } from '@tanstack/react-router';
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import { CollapsibleCard } from '../body/CollapsibleCard';
import type { SessionMeta } from './api';
import styles from './RoomMap.module.css';
import ring from './SwarmNetwork.module.css';
import { orderRoom, swarmPlace, type SwarmView } from './roomOrder';
import { ClosedSwarmsToggle, SwarmNetworkKey } from './SwarmNetwork';
import type { MemberState, ProjectView, RoomMove, RoomView } from './swarmApi';
import { SwarmStack } from './SwarmStack';
import { shortTitle } from './swarmNetworkMath';

/** A session's state, read from the roster the same way the swarm cards
 * read theirs: asking her beats working beats resting. */
export function stateOf(meta: SessionMeta | undefined, fallback: MemberState): MemberState {
  if (!meta) return fallback;
  if (meta.awaiting_input) return 'needs_input';
  if (meta.running) return 'working';
  return 'silent';
}

/** One ring — the same drawing SwarmNetwork uses for a session. */
export function Ring({ state, big = false }: { state: MemberState; big?: boolean }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={ring.ringBox} aria-hidden="true">
      {big ? null : <circle cx="16" cy="16" r="10" className={ring.ring} />}
      {state === 'needs_input'
        ? <circle cx="16" cy="16" r="14.5" className={ring.waitRing} />
        : <circle cx="16" cy="16" r="14" className={ring.halo} />}
      {state === 'working' ? <circle cx="16" cy="16" r={big ? 12 : 6.5} className={ring.spinner} /> : null}
      <circle cx="16" cy="16" r={big ? 9 : 3.5} className={ring.dot} />
    </svg>
  );
}

const MOVE_WORDS: Record<RoomMove['kind'], string> = {
  form: 'formed a swarm from',
  join: 'moved into a swarm:',
  split: 'split out of a swarm:',
  release: 'released to work alone:',
};

/** One helper move in words: what it did, to how many, and why. */
export function moveLine(move: RoomMove): string {
  const sessions = `${move.convs.length} ${move.convs.length === 1 ? 'session' : 'sessions'}`;
  const where = move.to_swarm !== null ? ` (swarm ${move.to_swarm})` : '';
  return `${MOVE_WORDS[move.kind]} ${sessions}${where} — ${move.reason}`;
}

/** How many members of these swarms need her, for a title line. */
function needingIn(swarms: SwarmView[]): number {
  return swarms.reduce((total, swarm) => total + swarm.counts.needs_input, 0);
}

/** One helper's part of the map: its dot on top with its last move, its swarm
 * stacks in the room's order, and its sessions working alone in rows. Drawn
 * for the room, inside each project box, and on a project's own page. */
export function MapBody({
  helperConv,
  helperLabel,
  moves,
  solos,
  swarms,
  rosterById,
  onOpen,
  onChanged,
  emptySwarms,
}: {
  helperConv: string | null;
  helperLabel: string;
  moves: RoomMove[];
  solos: RoomView['solos'];
  swarms: SwarmView[];
  rosterById: Map<string, SessionMeta>;
  onOpen: (conv: string) => void;
  onChanged?: () => void;
  emptySwarms: string;
}) {
  const lastMove = moves.find((m) => !m.undone_at);
  const helperMeta = helperConv ? rosterById.get(helperConv) : undefined;
  // The swarms in the room's order: one with a question first, longest wait
  // on top, then working, then resting (roomOrder.ts).
  const orderedSwarms = orderRoom(swarms.map((swarm) => ({ item: swarm, ...swarmPlace(swarm) })));
  return (
    <>
      {/* The helper, above everything it arranges. */}
      {helperConv ? (
        <div className={styles.top}>
          <button
            type="button"
            className={[styles.agent, styles.roomHelper, ring[`state_${stateOf(helperMeta, 'silent')}`]].join(' ')}
            onClick={() => onOpen(helperConv)}
            {...agentPointerProps(helperConv)}
            title={`The ${helperLabel.toLowerCase()} — tap to open its chat`}
          >
            <Ring state={stateOf(helperMeta, 'silent')} big />
            <span className={styles.agentName}>{helperLabel}</span>
          </button>
          {lastMove ? (
            <p className={styles.lastMove}>Last move: {moveLine(lastMove)}</p>
          ) : null}
        </div>
      ) : null}

      {/* Each swarm as one stack: summary, circle, questions, members. */}
      {orderedSwarms.length > 0 ? (
        <div className={styles.stacks}>
          {orderedSwarms.map((swarmView) => (
            <SwarmStack
              key={swarmView.swarm.id}
              view={swarmView}
              rosterById={rosterById}
              onOpen={onOpen}
              onChanged={onChanged}
            />
          ))}
        </div>
      ) : (
        <p className={styles.note}>{emptySwarms}</p>
      )}

      {/* Everyone working alone, in rows underneath. */}
      <h4 className={styles.soloHead}>Working alone</h4>
      {solos.length > 0 ? (
        <div className={styles.solos}>
          {solos.map((solo) => {
            const state = stateOf(rosterById.get(solo.conv), solo.state);
            return (
              <button
                key={solo.conv}
                type="button"
                className={[styles.agent, ring[`state_${state}`]].join(' ')}
                onClick={() => onOpen(solo.conv)}
                {...agentPointerProps(solo.conv)}
                title={solo.summary ? `${solo.title} — ${solo.summary}` : solo.title}
              >
                <Ring state={state} />
                <span className={styles.agentName}>{shortTitle(solo.title)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className={styles.note}>Nobody — every session here is in a swarm.</p>
      )}
    </>
  );
}

/** The swarms of one project room, picked out of the room's by id. */
export function projectSwarms(project: ProjectView, swarms: SwarmView[]): SwarmView[] {
  const ids = new Set(project.swarm_ids);
  return swarms.filter((view) => ids.has(view.swarm.id));
}

/** One project room as a box inside the room map: shut or open as she left
 * it, saying on its title line how many in it need her. */
function ProjectBox({
  project,
  swarms,
  rosterById,
  onOpen,
  onChanged,
}: {
  project: ProjectView;
  swarms: SwarmView[];
  rosterById: Map<string, SessionMeta>;
  onOpen: (conv: string) => void;
  onChanged?: () => void;
}) {
  const needing = needingIn(swarms);
  return (
    <CollapsibleCard
      cardKey={`project-room-${project.id}`}
      title={`${project.name} — project room`}
      defaultOpen
      note={needing > 0 ? `${needing} need${needing === 1 ? 's' : ''} you` : undefined}
      classes={{ note: styles.titleNote }}
    >
      <div className={styles.map}>
        <MapBody
          helperConv={project.helper_conv}
          helperLabel="Project helper"
          moves={project.moves}
          solos={project.solos}
          swarms={swarms}
          rosterById={rosterById}
          onOpen={onOpen}
          onChanged={onChanged}
          emptySwarms={`No swarms in ${project.name} right now.`}
        />
        <Link
          to="/observatory/project/$projectId"
          params={{ projectId: project.id }}
          className={styles.projectLink}
        >
          Open the {project.name} page
        </Link>
      </div>
    </CollapsibleCard>
  );
}

export function RoomMap({
  room,
  view,
  swarms,
  closedCount = 0,
  rosterById,
  onOpen,
  onChanged,
  helperInBand = false,
}: {
  room: string;
  view: RoomView;
  /** The swarms in this room to draw, read through the roster
   * (roomOrder.swarmView) — closed ones only when she asked. */
  swarms: SwarmView[];
  /** How many swarms here are closed (fewer than two sessions still at work), for the switch. */
  closedCount?: number;
  /** Every session the page knows, for the rings' live state. */
  rosterById: Map<string, SessionMeta>;
  onOpen: (conv: string) => void;
  /** After she answers a question here, so the roster refreshes. */
  onChanged?: () => void;
  /** The room helper is up in the band at the top of the page
   * (RoomHelperBand.tsx), so its dot leaves this map and shows once. */
  helperInBand?: boolean;
}) {
  const projects = view.projects ?? [];
  // A project's swarms are drawn in its box, so the room's own are the rest.
  const inAProject = new Set(projects.flatMap((project) => project.swarm_ids));
  const ownSwarms = swarms.filter((view) => !inAProject.has(view.swarm.id));
  // Say on the title line how many swarm members need her, so it still shows
  // with the card shut — the project boxes' too.
  const needing = needingIn(swarms);

  return (
    <CollapsibleCard
      cardKey={`room-map-${room}`}
      title="The room from above"
      defaultOpen
      note={needing > 0 ? `${needing} need${needing === 1 ? 's' : ''} you` : undefined}
      classes={{ note: styles.titleNote }}
    >
      <div className={styles.map}>
        {swarms.length > 0 ? <SwarmNetworkKey /> : null}
        {projects.length > 0 ? (
          <div className={styles.projects}>
            {projects.map((project) => (
              <ProjectBox
                key={project.id}
                project={project}
                swarms={projectSwarms(project, swarms)}
                rosterById={rosterById}
                onOpen={onOpen}
                onChanged={onChanged}
              />
            ))}
          </div>
        ) : null}
        <MapBody
          helperConv={helperInBand ? null : view.helper_conv}
          helperLabel="Room helper"
          moves={view.moves}
          solos={view.solos}
          swarms={ownSwarms}
          rosterById={rosterById}
          onOpen={onOpen}
          onChanged={onChanged}
          emptySwarms="No swarms in this room right now."
        />
        <ClosedSwarmsToggle closedCount={closedCount} />
      </div>
    </CollapsibleCard>
  );
}
