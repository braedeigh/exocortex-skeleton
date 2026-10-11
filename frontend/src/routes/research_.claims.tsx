import { createFileRoute, redirect } from '@tanstack/react-router';
import { ClaimsPage, type ClaimsSearch } from '../features/research/ClaimsPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /research/claims — the claims table with the annotated source beside each
 * claim (features/research/ClaimsPage.tsx). Un-nested from /research (the
 * `research_.` prefix) so it is its own page rather than a child inside the
 * directory's layout, like /observatory/helpers. Selection lives in the
 * search params: ?claim=<id> opens one claim, ?topic= / ?front= filter the
 * table. Auth-only — it reads research sessions' output.
 */

export const Route = createFileRoute('/research_/claims')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ClaimsRoute,
  validateSearch: (search: Record<string, unknown>): ClaimsSearch => {
    const text = (key: string) => (typeof search[key] === 'string' && search[key] ? (search[key] as string) : undefined);
    const out: ClaimsSearch = {};
    const claim = text('claim');
    const topic = text('topic');
    const front = text('front');
    if (claim) out.claim = claim;
    if (topic) out.topic = topic;
    if (front) out.front = front;
    return out;
  },
});

function ClaimsRoute() {
  useDeactivateFrames();
  return <ClaimsPage />;
}
