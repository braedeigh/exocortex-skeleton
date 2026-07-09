import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { useDeactivateFrames } from '../shell/useIframeView';

// Dynamic import so Leaflet (+ the whole map feature) stays out of the main
// bundle and only loads when the Ecosystem tab is opened — the old frontend
// lazy-loaded ecosystem.js/Leaflet for the same reason.
const EcosystemPage = lazy(() =>
  import('../features/ecosystem/EcosystemPage').then((m) => ({ default: m.EcosystemPage })),
);

export const Route = createFileRoute('/ecosystem')({
  component: EcosystemRoute,
  // ?recipe=<id> deep link from kitchen's "View on map".
  validateSearch: (search: Record<string, unknown>): { recipe?: string } => {
    const recipe = typeof search.recipe === 'string' && search.recipe ? search.recipe : undefined;
    return recipe ? { recipe } : {};
  },
});

function EcosystemRoute() {
  useDeactivateFrames();
  const { recipe } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <EcosystemPage initialRecipeId={recipe ?? ''} />
    </Suspense>
  );
}
