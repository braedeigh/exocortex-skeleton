import { createFileRoute, redirect } from '@tanstack/react-router';
import { LinearPage } from '../features/observatory/LinearPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/linear — the Linear room: sessions that work in Linear with
 * her. Reached by the Linear door on the roster, and un-nested like
 * /observatory/research. Owner only, because it opens onto session output.
 */
export const Route = createFileRoute('/observatory_/linear')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: LinearRoute,
});

function LinearRoute() {
  useDeactivateFrames();
  return <LinearPage />;
}
