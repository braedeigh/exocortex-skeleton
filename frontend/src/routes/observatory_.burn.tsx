import { createFileRoute, redirect } from '@tanstack/react-router';
import { TokenBurnPage } from '../features/observatory/TokenBurnPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/burn — the Token burn page: what the agents spent, by model,
 * session, room or kind of token, and when. Reached by the Token burn door
 * on the roster. Owner only: session titles are on it.
 */
export const Route = createFileRoute('/observatory_/burn')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TokenBurnRoute,
});

function TokenBurnRoute() {
  useDeactivateFrames();
  return <TokenBurnPage />;
}
