import { createFileRoute, redirect } from '@tanstack/react-router';
import { NutrientPage } from '../features/nutrition/NutrientPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/nutrients/<key> — one nutrient's own page: her day's total for it,
 * what the NIH ODS fact sheet says happens without enough, and every USDA
 * food ranked by it (features/nutrition/NutrientPage.tsx). The key is
 * nutrition.py's (iron, vitamin_d, …). Auth-only, like the rest of the Food area.
 */
export const Route = createFileRoute('/food_/nutrients/$key')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: NutrientRoute,
});

function NutrientRoute() {
  useDeactivateFrames();
  const { key } = Route.useParams();
  return <NutrientPage key={key} nutrientKey={key} />;
}
