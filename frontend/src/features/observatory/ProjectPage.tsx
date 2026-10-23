/**
 * ProjectPage.tsx — one project room, opened: its helper, its swarms and its
 * sessions working alone, the same map as its box in the room.
 *
 * What this is, in plain English: a project room is a build of its own (a
 * repo on the Builds list) switched on as a room inside the Coding room
 * (project_rooms.py). Its project helper looks after the swarms that form
 * among the sessions working on it. This page draws that one project from
 * above — the project helper's dot on top with its last move, each swarm as
 * its stack (SwarmStack.tsx), every session working alone in rows beneath —
 * exactly as its box does in the room map (RoomMap.tsx `MapBody`), but whole.
 * A swarm's page links back here ("‹ <project>").
 *
 * Touches: swarmApi.ts (useProjectView — routes/swarms.py `project`; useSwarms
 * for the stacks), RoomMap.tsx (MapBody, projectSwarms), roomOrder.ts
 * (swarmView), api.ts (the roster, for the rings' live state),
 * NightCrewPage.module.css (the page frame),
 * routes/observatory_.project.$projectId.tsx (the address).
 *
 * Prompt that produced it: "maybe we make rooms where swarms can form like
 * based foods. Swarms could form within the room?"
 */
import { useNavigate } from '@tanstack/react-router';
import { useSessionRoster } from './api';
import pageStyles from './NightCrewPage.module.css';
import { openedMap } from './readReceipts';
import { MapBody, projectSwarms } from './RoomMap';
import styles from './RoomMap.module.css';
import { swarmView } from './roomOrder';
import { sessionLocation } from './sessionLocation';
import { SwarmNetworkKey } from './SwarmNetwork';
import { shownSwarms, useClosedSwarmsShown, useProjectView, useSwarms } from './swarmApi';

export function ProjectPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data: project, error, refetch } = useProjectView(projectId);
  const { data: allSwarms } = useSwarms();
  const { data: roster, refetch: refetchRoster } = useSessionRoster(true);
  const open = (convId: string) => void navigate(sessionLocation(convId));
  // Its swarms read through the roster, as the room's are (roomOrder.swarmView).
  const rosterById = new Map((roster?.sessions ?? []).map((s) => [s.id, s]));
  const opened = openedMap();
  const showClosed = useClosedSwarmsShown();
  const views = shownSwarms(allSwarms ?? [], showClosed).map((s) => swarmView(s, rosterById, opened));
  const swarms = project ? projectSwarms(project, views) : [];

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate({ to: '/observatory' })}>
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>{project ? `${project.name} — project room` : 'Project room'}</h1>
        </div>
        {error ? <p className={styles.note}>Couldn&rsquo;t load this project room.</p> : null}
        {project ? (
          <div className={styles.map}>
            {swarms.length > 0 ? <SwarmNetworkKey /> : null}
            <MapBody
              helperConv={project.helper_conv}
              helperLabel="Project helper"
              moves={project.moves}
              solos={project.solos}
              swarms={swarms}
              rosterById={rosterById}
              onOpen={open}
              onChanged={() => {
                void refetch();
                void refetchRoster();
              }}
              emptySwarms={`No swarms in ${project.name} right now.`}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
