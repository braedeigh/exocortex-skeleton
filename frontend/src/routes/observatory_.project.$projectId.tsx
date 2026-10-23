import { createFileRoute, redirect } from '@tanstack/react-router';
import { ProjectPage } from '../features/observatory/ProjectPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/project/<id> — one project room's page: its project helper,
 * its swarms and its sessions working alone (ProjectPage.tsx). Reached from
 * the project's box in the Coding room's map, and from a swarm page's
 * "‹ <project>" button. Un-nested like /observatory/swarm/<id>.
 * Auth-only — it names sessions and shows what they're doing.
 */
export const Route = createFileRoute('/observatory_/project/$projectId')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ProjectRoute,
});

function ProjectRoute() {
  useDeactivateFrames();
  const { projectId } = Route.useParams();
  return <ProjectPage projectId={projectId} />;
}
