import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainPage } from '../features/terrain/TerrainPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain — the file-tree heatmap: where the observatory's sessions have
 * been working, files glowing ember by recency. Auth-only, same guard as
 * /atlas and /observatory: it surfaces repo structure and session titles,
 * so public visitors bounce to '/'.
 */
export const Route = createFileRoute('/terrain')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TerrainRoute,
});

function TerrainRoute() {
  useDeactivateFrames();
  return <TerrainPage />;
}
