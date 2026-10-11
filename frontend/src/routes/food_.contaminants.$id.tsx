import { createFileRoute, redirect } from '@tanstack/react-router';
import { ContaminantPage } from '../features/exposure/ContaminantPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/contaminants/<id> — one contaminant: how harmful it might be (its
 * sourced, reviewable facts) and every food it was found in
 * (features/exposure/ContaminantPage.tsx). Keyed by the hazard's id.
 * Auth-only.
 */
export const Route = createFileRoute('/food_/contaminants/$id')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ContaminantRoute,
});

function ContaminantRoute() {
  useDeactivateFrames();
  const { id } = Route.useParams();
  return <ContaminantPage key={id} id={Number(id)} />;
}
