import { createFileRoute, redirect } from '@tanstack/react-router';
import { NightCrewPage } from '../features/observatory/NightCrewPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/nightcrew — the night crew's own page: finished work on a
 * branch, waiting on her verdict.
 *
 * It used to be a section stacked on the roster. It's a page now because it's a
 * READING surface, not a scanning one (see NightCrewPage.tsx for the full
 * reasoning) — reached by the door left exactly where the section was.
 *
 * Un-nested (the `observatory_.` prefix) for the same reason
 * observatory_.archive and observatory_.$botId are: it's a page of its own, not
 * something rendered inside the roster.
 *
 * Auth-only, same guard as the rest of the Observatory — it surfaces branch
 * contents and session output, so public visitors bounce to '/'.
 */
export const Route = createFileRoute('/observatory_/nightcrew')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: NightCrewRoute,
});

function NightCrewRoute() {
  useDeactivateFrames();
  return <NightCrewPage />;
}
