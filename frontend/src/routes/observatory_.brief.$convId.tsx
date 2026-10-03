import { createFileRoute, redirect } from '@tanstack/react-router';
import { SessionBriefPage } from '../features/observatory/SessionBriefPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/brief/<session id> — what one spun-off session was asked to
 * do: its brief, the files pasted into its hidden instructions, and its
 * handoffs, all read from the database (SessionBriefPage.tsx). Reached from
 * the "brief" button in a spun-off session's chat. Un-nested like
 * /observatory/context/<id>.
 * Auth-only — a brief quotes what she asked for.
 */
export const Route = createFileRoute('/observatory_/brief/$convId')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: SessionBriefRoute,
});

function SessionBriefRoute() {
  useDeactivateFrames();
  const { convId } = Route.useParams();
  return <SessionBriefPage key={convId} convId={convId} />;
}
