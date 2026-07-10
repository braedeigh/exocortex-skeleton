import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { useDeactivateFrames } from '../shell/useIframeView';

// The standalone, shareable food-sourcing map (port of templates/food_map.html)
// — the same ecosystem feature module, reached at a public URL. VIEW_MODE
// gates editing inside EcosystemPage itself: anonymous visitors get the map,
// legend, filters and recipe tracing read-only.
const EcosystemPage = lazy(() =>
  import('../features/ecosystem/EcosystemPage').then((m) => ({ default: m.EcosystemPage })),
);

export const Route = createFileRoute('/food-map')({
  component: FoodMapRoute,
});

function FoodMapRoute() {
  useDeactivateFrames();
  return (
    <Suspense fallback={null}>
      <EcosystemPage />
    </Suspense>
  );
}
