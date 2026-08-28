import { createFileRoute } from '@tanstack/react-router';
import { HousingPage } from '../features/housing/HousingPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Housing tab — apartment-search tracker (native port of #tab-housing).
export const Route = createFileRoute('/housing')({
  component: HousingRoute,
});

function HousingRoute() {
  useDeactivateFrames();
  return <HousingPage />;
}
