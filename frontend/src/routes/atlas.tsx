import { createFileRoute, redirect } from '@tanstack/react-router';
import { AtlasPage } from '../features/atlas/AtlasPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /atlas — a visualizer of every reading-room session sorted into its home
 * (the exocortex front's five domain shelves, the other 11 life fronts,
 * Unsorted). Auth-only, same guard as /reading-room: it surfaces session
 * content, so public visitors bounce to '/'.
 */
export const Route = createFileRoute('/atlas')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: AtlasRoute,
});

function AtlasRoute() {
  useDeactivateFrames();
  return <AtlasPage />;
}
