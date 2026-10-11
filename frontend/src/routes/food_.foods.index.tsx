import { createFileRoute, redirect } from '@tanstack/react-router';
import { FoodsIndex } from '../features/research/FoodPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/foods — every food in the catalog, known ones first
 * (features/research/FoodPage.tsx FoodsIndex). Each row opens the food's own
 * page. Un-nested from /food so it's a full page, not drawn inside the map.
 * Auth-only; /research/foods redirects here.
 */
export const Route = createFileRoute('/food_/foods/')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: FoodsRoute,
});

function FoodsRoute() {
  useDeactivateFrames();
  return <FoodsIndex />;
}
