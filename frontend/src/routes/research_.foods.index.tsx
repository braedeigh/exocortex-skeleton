import { createFileRoute, redirect } from '@tanstack/react-router';
import { FoodsIndex } from '../features/research/FoodPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /research/foods — every food in the catalog with what's known about buying
 * it organic (features/research/FoodPage.tsx). Each row opens the food's own
 * page. Un-nested from /research like /research/claims. Auth-only.
 */

export const Route = createFileRoute('/research_/foods/')({
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
