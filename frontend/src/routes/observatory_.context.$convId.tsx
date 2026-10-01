import { createFileRoute, redirect } from '@tanstack/react-router';
import { HelperContextPage } from '../features/observatory/HelperContextPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/context/<helper's session id> — what one helper is working
 * from: the document each turn of its rolling chat starts with, part by part,
 * and her standing rules for it, which she can edit (HelperContextPage.tsx).
 * Reached from the "context" button in a helper's chat and from its swarm's
 * page. Un-nested like /observatory/swarm/<id>.
 * Auth-only — it shows what she said to the helper and what sessions did.
 */
export const Route = createFileRoute('/observatory_/context/$convId')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: HelperContextRoute,
});

function HelperContextRoute() {
  useDeactivateFrames();
  const { convId } = Route.useParams();
  // Keyed by the helper, so opening another helper's page starts with an
  // empty edit rather than the last one's unsaved text.
  return <HelperContextPage key={convId} convId={convId} />;
}
