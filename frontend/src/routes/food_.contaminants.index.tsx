import { createFileRoute, redirect } from '@tanstack/react-router';
import { ContaminantsIndex } from '../features/exposure/ContaminantPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/contaminants — every contaminant found in a scored food or named in a
 * study, most concerning first (features/exposure/ContaminantPage.tsx).
 * Auth-only, like the rest of the Food area's pages.
 */
export const Route = createFileRoute('/food_/contaminants/')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ContaminantsRoute,
});

function ContaminantsRoute() {
  useDeactivateFrames();
  return <ContaminantsIndex />;
}
