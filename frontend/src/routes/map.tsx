import { createFileRoute } from '@tanstack/react-router';
import { LifeMapPage } from '../features/lifemap/LifeMapPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Life Map — habit tracker grid, activity calendar + reminder registry,
// keep-in-touch contacts (port of index.html #tab-map, old tab id 'map').
export const Route = createFileRoute('/map')({
  component: MapRoute,
});

function MapRoute() {
  useDeactivateFrames();
  return <LifeMapPage />;
}
