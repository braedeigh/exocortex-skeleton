import { createFileRoute, redirect } from '@tanstack/react-router';
import { ResearchPage } from '../features/observatory/ResearchPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/research — the research room: her desk sessions and the
 * dispatched research workers. Reached by the Research door on the roster; a
 * reading-and-starting surface like /observatory/helpers, un-nested for the
 * same reason. Auth-only — it opens onto session output.
 */
export const Route = createFileRoute('/observatory_/research')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ResearchRoute,
});

function ResearchRoute() {
  useDeactivateFrames();
  return <ResearchPage />;
}
