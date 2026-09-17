import { createFileRoute, redirect } from '@tanstack/react-router';
import { WiringView } from '../features/wiring/WiringView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/wiring — the codebase's own wiring, drawn the way the creek draws
 * data flow.
 *
 * Sits beside the creek under /terrain because they are two halves of one
 * question: the creek is "which files touch which vault collections", this is
 * "which files touch each other". Same banks-and-ribbons idiom, re-aimed —
 * see WiringView.tsx for why the geometry had to change (nothing in a code
 * graph belongs on only one bank).
 *
 * Un-nested (the `terrain_.` prefix) like the other rooms: the map unmounts
 * and this owns the screen, "← Terrain" walks back. Same auth guard — this
 * names the codebase's internals and its live request paths, kept out of
 * public view like everything else under /terrain.
 */
export const Route = createFileRoute('/terrain_/wiring')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: WiringRoute,
});

function WiringRoute() {
  useDeactivateFrames();
  return <WiringView />;
}
