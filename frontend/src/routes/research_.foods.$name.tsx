import { createFileRoute, redirect } from '@tanstack/react-router';
import { FoodPage } from '../features/research/FoodPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /research/foods/<name> — one food's page: buy organic or not, Claude's
 * guess, and every claim and study about it (features/research/FoodPage.tsx).
 * The grocery list's popup opens this. Keyed by the name as written, so a
 * list item with no food in the catalog yet still has a page. Auth-only.
 */

export const Route = createFileRoute('/research_/foods/$name')({
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
