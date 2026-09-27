import { createFileRoute, redirect } from '@tanstack/react-router';
import { WorktreeMapPage } from '../features/observatory/WorktreeMapPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/worktrees — which agents are working in which copy of the code
 * (WorktreeMapPage.tsx). Reached from the door under the Coding room.
 * Un-nested like /observatory/nightcrew. Auth-only — it names sessions and
 * shows the commands they ran.
 */
export const Route = createFileRoute('/observatory_/worktrees')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: WorktreeMapRoute,
});

function WorktreeMapRoute() {
  useDeactivateFrames();
  return <WorktreeMapPage />;
}
