import { createFileRoute, redirect } from '@tanstack/react-router';
import { HelpersPage } from '../features/observatory/HelpersPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/helpers — the history of button-fired Claude jobs (triage,
 * recipe/receipt parses, person impressions). Reached by the Helpers door at
 * the bottom of the roster; a reading surface like /observatory/nightcrew,
 * un-nested for the same reason. Auth-only — it opens onto session output.
 */
export const Route = createFileRoute('/observatory_/helpers')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: HelpersRoute,
});

function HelpersRoute() {
  useDeactivateFrames();
  return <HelpersPage />;
}
