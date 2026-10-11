import { createFileRoute, redirect } from '@tanstack/react-router';
import { NutritionPage } from '../features/nutrition/NutritionPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/nutrients — her usual day of meals added up against the daily
 * targets (features/nutrition/NutritionPage.tsx). Auth-only, like the rest of
 * the Food area's pages. It's an index route (trailing slash) so that
 * /food/nutrients/<key> is a sibling page, not a child with nowhere to draw.
 */
export const Route = createFileRoute('/food_/nutrients/')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: NutrientsRoute,
});

function NutrientsRoute() {
  useDeactivateFrames();
  return <NutritionPage />;
}
