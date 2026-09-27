import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { useDeactivateFrames } from '../shell/useIframeView';

// The standalone, shareable food-sourcing map — the same ecosystem feature
// module, reached at a public URL. VIEW_MODE gates editing inside
// EcosystemPage itself: visitors get the map, legend, filters and recipe
// tracing read-only.
//
// `?embed=1` is the EXHIBIT: chrome-free, the map filling the frame, built for
// the portfolio page's <iframe> the same way /terrain/map?embed=1 is
// (shell/embed.ts). `?recipe=<id>` opens with that recipe already traced —
// the portfolio passes both, so the frame is alive before anyone touches it.
// The id travels in the URL rather than living here, so the skeleton never
// carries a personal recipe id.
const EcosystemPage = lazy(() =>
  import('../features/ecosystem/EcosystemPage').then((m) => ({ default: m.EcosystemPage })),
);

export const Route = createFileRoute('/food-map')({
  validateSearch: (raw: Record<string, unknown>): { recipe?: string; source?: string; embed?: boolean } => ({
    ...(typeof raw.recipe === 'string' && raw.recipe ? { recipe: raw.recipe } : {}),
    ...(typeof raw.source === 'string' && raw.source ? { source: raw.source } : {}),
    ...(raw.embed === '1' || raw.embed === 1 || raw.embed === true ? { embed: true } : {}),
  }),
  component: FoodMapRoute,
});

function FoodMapRoute() {
  useDeactivateFrames();
  const { recipe, source, embed } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <EcosystemPage initialRecipeId={recipe ?? ''} initialSourceId={source ?? ''} embed={!!embed} />
    </Suspense>
  );
}
