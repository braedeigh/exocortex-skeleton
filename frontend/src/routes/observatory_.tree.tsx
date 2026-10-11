import { createFileRoute, redirect } from '@tanstack/react-router';
import { SpinoffTreePage } from '../features/observatory/SpinoffTreePage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/tree — the spinoff family tree (which session was spun off
 * from which). Reached by the Spinoff tree door at the bottom of the roster;
 * un-nested like /observatory/helpers. Auth-only — it names sessions.
 */
export const Route = createFileRoute('/observatory_/tree')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: SpinoffTreeRoute,
});

function SpinoffTreeRoute() {
  useDeactivateFrames();
  return <SpinoffTreePage />;
}
