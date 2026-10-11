import { createFileRoute, redirect } from '@tanstack/react-router';
import { RunsView } from '../features/terrain/RunsView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/runs — what actually runs, and where what it makes ends up.
 *
 * The creek room next door draws the WIRING: which file can touch which
 * collection. This one draws the MOVEMENT: which process fired, what it wrote,
 * and who picks that up afterwards. Same two payloads, opposite question.
 *
 * Un-nested (`terrain_.`) like the other rooms, so the map unmounts and this
 * owns the screen, and behind the same auth guard — it names the codebase's own
 * internals, which stay out of public view.
 */
export const Route = createFileRoute('/terrain_/runs')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: RunsRoute,
});

function RunsRoute() {
  useDeactivateFrames();
  return <RunsView />;
}
