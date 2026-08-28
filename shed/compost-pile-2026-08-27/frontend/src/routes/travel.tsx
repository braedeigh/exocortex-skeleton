import { createFileRoute } from '@tanstack/react-router';
import { TravelPage } from '../features/travel/TravelPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Travel — trips + packing lists drawn from archivals/consumables (new
// native page, no legacy tab behind it).
export const Route = createFileRoute('/travel')({
  component: TravelRoute,
});

function TravelRoute() {
  useDeactivateFrames();
  return <TravelPage />;
}
