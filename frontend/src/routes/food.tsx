import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food — the Food area's front page: the map of where her food comes from
 * (features/ecosystem/EcosystemPage.tsx), with the row of doors to every food
 * and the review list above it. The old /ecosystem address redirects here.
 *
 * Deep links: ?recipe=<id> (the Kitchen's "View on map"), ?source=<id> (one
 * source's panel open), ?food=<id> (only that food's sources — a food's page
 * links here).
 *
 * Leaflet and the whole map feature load on demand (lazy), so they stay out
 * of the main bundle.
 */
const EcosystemPage = lazy(() =>
  import('../features/ecosystem/EcosystemPage').then((m) => ({ default: m.EcosystemPage })),
);

export interface FoodMapSearch {
  recipe?: string;
  source?: string;
  food?: number;
}

/** Read the map's deep-link params — shared with the /ecosystem redirect. */
export function validateFoodMapSearch(search: Record<string, unknown>): FoodMapSearch {
  const out: FoodMapSearch = {};
  if (typeof search.recipe === 'string' && search.recipe) out.recipe = search.recipe;
  if (typeof search.source === 'string' && search.source) out.source = search.source;
  const food = Number(search.food);
  if (search.food != null && search.food !== '' && Number.isInteger(food)) out.food = food;
  return out;
}

export const Route = createFileRoute('/food')({
  component: FoodMapRoute,
  validateSearch: validateFoodMapSearch,
});

function FoodMapRoute() {
  useDeactivateFrames();
  const { recipe, source, food } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <EcosystemPage initialRecipeId={recipe ?? ''} initialSourceId={source ?? ''} initialFoodId={food ?? null} nav />
    </Suspense>
  );
}
