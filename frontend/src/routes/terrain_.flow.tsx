import { createFileRoute, redirect } from '@tanstack/react-router';
import { FlowLane } from '../features/flow/FlowLane';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/flow — code as it's being written, live: every Edit/Write across
 * the working sessions as a stream of cards, newest first, each carrying the
 * lines it wrote (features/flow/FlowLane.tsx, fed by /api/observatory/flow).
 *
 * It lives under /terrain because the terrain is where the system looks at
 * itself: the map is where work has happened, this is what's being written
 * right now. Built to be parked in a tile under the map on a watching
 * monitor. Un-nested (the `terrain_.` prefix), same as the other rooms; "←
 * Terrain" walks back. Same auth guard as the map — it shows repo source, so
 * public visitors bounce to '/'.
 */
export const Route = createFileRoute('/terrain_/flow')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: FlowRoute,
});

function FlowRoute() {
  useDeactivateFrames();
  return <FlowLane />;
}
