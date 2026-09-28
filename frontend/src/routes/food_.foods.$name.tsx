import { createFileRoute, redirect } from '@tanstack/react-router';
import { FoodPage } from '../features/research/FoodPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/foods/<name> — one food's page: where it comes from (a small map and
 * the machine's suggestions), buy organic or not, Claude's guess, and every
 * claim and study about it (features/research/FoodPage.tsx). Keyed by the
 * name as written, so a grocery item with no food in the catalog yet still
 * has a page. Auth-only; /research/foods/<name> redirects here.
 */
export const Route = createFileRoute('/food_/foods/$name')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: FoodRoute,
});

function FoodRoute() {
  useDeactivateFrames();
  const { name } = Route.useParams();
  return <FoodPage key={name} name={name} />;
}
