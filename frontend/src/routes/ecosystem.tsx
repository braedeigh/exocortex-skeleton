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
  // Deep links: ?recipe=<id> (kitchen's "View on map"), ?source=<id> (one
  // source's panel open), ?food=<id> (only that food's sources — a food's
  // page under Research links here).
  validateSearch: (search: Record<string, unknown>): { recipe?: string; source?: string; food?: number } => {
    const out: { recipe?: string; source?: string; food?: number } = {};
    if (typeof search.recipe === 'string' && search.recipe) out.recipe = search.recipe;
    if (typeof search.source === 'string' && search.source) out.source = search.source;
    const food = Number(search.food);
    if (search.food != null && search.food !== '' && Number.isInteger(food)) out.food = food;
    return out;
  },
});

function EcosystemRoute() {
  useDeactivateFrames();
  const { recipe, source, food } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <EcosystemPage initialRecipeId={recipe ?? ''} initialSourceId={source ?? ''} initialFoodId={food ?? null} />
    </Suspense>
  );
}
