/**
 * HelperSessions.tsx — the rail beside a room or project helper's chat: the open
 * sessions that helper looks after, drawn like the room on the Observatory page.
 *
 * What this is, in plain English: when she's talking to a helper she's usually
 * talking about its sessions. So on desktop its chat gets a rail on the right.
 * For the room helper that's its whole room, Coding, project rooms included; for
 * a project helper, that project room. It has the room's numbers, a tile per swarm
 * and one line per session, the same pieces as the overview (RosterMap.tsx). Click
 * a swarm's tile to unfold its sessions, click a session to open it in a pane
 * beside the chat, so the helper stays on screen (`keep`, conversationRouting.ts).
 * The fold at the top shuts the rail to a slim strip, remembered. In a panel too
 * narrow for both (a session pane opened beside it can do that) it starts as the
 * strip, and tapping that opens the rail over the chat.
 *
 * ONLY A VIEW. It reads the roster and the room view the Observatory already polls
 * and sends the helper nothing, so it adds nothing to what a helper is told.
 *
 * Nothing is drawn on a phone, in the desktop app, or for any other session, a
 * swarm's helper included.
 *
 * Touches: routes/observatory_.$botId.tsx (puts it beside the chat), mapPlaces.ts
 * (helperScope, placeRoster), RosterMap.tsx (the shared pieces), swarmApi.ts,
 * paneConversation.ts, HelperSessions.module.css.
 *
 * Prompt that produced it: "i want for when i open a room or project helper on
 * desktop, all of the sessions that it's connected to that are currently open are
 * open on the side of it" · "It should basically look like the observatory room."
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { openConversationInPane } from '../../shell/paneConversation';
import { isStandalone } from '../../shell/standalone';
import { DESKTOP_QUERY, useMediaQuery } from '../../shell/useMediaQuery';
import { strayRoom, useSessionRoster, type SessionMeta } from './api';
import { LaneHead, useLaneOpen } from './LaneHead';
import { helperScope, placeRoster, roomCensus, type MapRing } from './mapPlaces';
import { openedMap } from './readReceipts';
import { swarmView, type SwarmView } from './roomOrder';
import { useRooms } from './roomsApi';
import { censusWords, SessionLines, SwarmTile } from './RosterMap';
import { sessionLocation } from './sessionLocation';
import { roomRoster } from './sessionFilters';
import { useShownWidth } from './SwarmNetwork';
import { shownSwarms, useClosedSwarmsShown, useHelperOf, useRoomViews, useSwarms } from './swarmApi';
import mapStyles from './RosterMap.module.css';
import styles from './HelperSessions.module.css';

/** Narrower than this the panel can't hold a usable chat beside the rail, so the
 * rail waits as a slim strip and opens over the chat. */
const BESIDE_FROM_PX = 600;

/** The gate: the full rail's polls run only for a helper's chat, on desktop. */
export function HelperSessions({ conv }: { conv: string }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const on = isDesktop && !isStandalone();
  const { data } = useHelperOf(on ? conv : undefined);
  return on && data?.is_helper ? <Rail conv={conv} /> : null;
}

/** One swarm: its tile, and its sessions once she unfolds it. */
function RailSwarm({
  view,
  rosterById,
  opened,
  onOpen,
}: {
  view: SwarmView;
  rosterById: Map<string, SessionMeta>;
  opened: Record<string, string>;
  onOpen: (convId: string) => void;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const rings: MapRing[] = view.members.map((member) => ({
    conv: member.conv,
    title: member.title,
    state: member.state,
    summary: member.summary,
  }));
  return (
    <>
      <SwarmTile view={view} selected={unfolded} onSelect={() => setUnfolded((was) => !was)} />
      {unfolded ? <SessionLines rings={rings} rosterById={rosterById} opened={opened} onOpen={onOpen} /> : null}
    </>
  );
}

function Rail({ conv }: { conv: string }) {
  const navigate = useNavigate();
  const rooms = useRooms();
  const roomIds = rooms.map((room) => room.id as string);
  const roomViews = useRoomViews(roomIds);
  const { data: roster } = useSessionRoster(true);
  const { data: allSwarms } = useSwarms();
  const showClosed = useClosedSwarmsShown();
  const [rememberedOpen, toggleRemembered] = useLaneOpen('helper-sessions');
  const [overOpen, setOverOpen] = useState(false);
  const [measure, shownWidth] = useShownWidth();
  // Beside the chat she decides and it's remembered; over the chat it's only for now.
  const beside = shownWidth >= BESIDE_FROM_PX;
  const open = beside ? rememberedOpen : overOpen;
  const toggle = beside ? toggleRemembered : () => setOverOpen((was) => !was);

  const sessions = roster?.sessions ?? [];
  const swarms = allSwarms ?? [];
  const opened = openedMap();
  const rosterById = new Map(sessions.map((s) => [s.id, s]));
  const places = placeRoster({
    rooms: roomIds,
    stray: strayRoom(),
    sessions: roomRoster(sessions, opened),
    views: shownSwarms(swarms, showClosed).map((s) => swarmView(s, rosterById, opened)),
    swarms,
    roomViews,
  });
  const scope = helperScope(conv, places, roomViews);

  // Open a session beside this chat, keeping the chat up. Moving this panel is
  // the fallback for a window where nothing catches it.
  const openBeside = (session: string) => {
    setOverOpen(false);
    if (!openConversationInPane(session, conv)) void navigate(sessionLocation(session));
  };

  // The anchor measures the chat's whole row: that's what says if the rail fits.
  const anchor = <div ref={measure} className={styles.measure} aria-hidden="true" />;
  if (!scope) return anchor;

  const heading = scope.kind === 'room' ? (rooms.find((r) => r.id === scope.place.room)?.name ?? scope.place.room) : scope.box.project.name;
  const needing =
    scope.kind === 'room'
      ? roomCensus(scope.place).needing
      : scope.box.swarms.reduce((total, view) => total + view.counts.needs_input, 0) +
        scope.box.solos.filter((ring) => ring.state === 'needs_input').length;
  const groups =
    scope.kind === 'room'
      ? [
          ...scope.place.projects.map((box) => ({
            key: box.project.id,
            name: box.project.name,
            swarms: box.swarms,
            rings: box.solos,
          })),
          { key: 'room', name: null, swarms: scope.place.swarms, rings: [...scope.place.solos, ...scope.place.others] },
        ]
      : [{ key: 'project', name: null, swarms: scope.box.swarms, rings: scope.box.solos }];
  const openCount =
    scope.kind === 'room'
      ? censusWords(scope.place, opened).open
      : groups.reduce((total, group) => total + group.rings.length + group.swarms.reduce((n, view) => n + view.members.length, 0), 0);

  return (
    <>
      {anchor}
      <aside className={!open ? styles.railShut : beside ? styles.rail : styles.railOver} aria-label={`Open sessions in ${heading}`}>
        {open ? (
          <>
            <LaneHead heading={heading} open onToggle={toggle} wanting={needing > 0}>
              <span className={mapStyles.numbers}>
                <span>{openCount} open</span>
                {needing > 0 ? <span className={mapStyles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
              </span>
            </LaneHead>
            {groups.map((group) => (
              <div key={group.key} className={group.name ? mapStyles.box : styles.group}>
                {group.name ? <h3 className={styles.groupName}>{group.name}</h3> : null}
                {group.swarms.map((view) => (
                  <RailSwarm key={view.swarm.id} view={view} rosterById={rosterById} opened={opened} onOpen={openBeside} />
                ))}
                <SessionLines rings={group.rings} rosterById={rosterById} opened={opened} onOpen={openBeside} />
              </div>
            ))}
            {openCount === 0 ? <p className={mapStyles.note}>No open sessions here.</p> : null}
          </>
        ) : (
          <button
            type="button"
            className={styles.unfold}
            onClick={toggle}
            aria-expanded={false}
            title={`Show the open sessions in ${heading}`}
            aria-label={`Show the open sessions in ${heading}`}
          >
            <span aria-hidden="true">&lsaquo;</span>
            {needing > 0 ? <span className={mapStyles.needing}>{needing}</span> : null}
          </button>
        )}
      </aside>
    </>
  );
}
