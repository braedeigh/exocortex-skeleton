import { createFileRoute, redirect } from '@tanstack/react-router';
import { SwarmPage } from '../features/observatory/SwarmPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/swarm/<id> — one swarm's page: its sessions, its helper's
 * summaries and runs, the messages between members (SwarmPage.tsx). Reached
 * from a swarm card in its room. Un-nested like /observatory/tree.
 * Auth-only — it names sessions and shows what they said.
 */
export const Route = createFileRoute('/observatory_/swarm/$swarmId')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: SwarmRoute,
});

function SwarmRoute() {
  useDeactivateFrames();
  const { swarmId } = Route.useParams();
  return <SwarmPage swarmId={Number(swarmId)} />;
}
