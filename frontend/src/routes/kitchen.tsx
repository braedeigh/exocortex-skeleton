import { createFileRoute } from '@tanstack/react-router';
import { KitchenPage } from '../features/kitchen/KitchenPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Kitchen tab — grocery list + catalog, receipt pipeline, recipes, meal
// notes, purchase history, spend trend. React port of index.html
// #tab-kitchen + kitchen.js + kitchen-recipes.js.
export const Route = createFileRoute('/kitchen')({
  component: KitchenRoute,
});

function KitchenRoute() {
  useDeactivateFrames();
  return <KitchenPage />;
}
