import { createFileRoute } from '@tanstack/react-router';
import { CarPage } from '../features/car/CarPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Native Car Maintenance page — replaces the /legacy/car iframe tab.
export const Route = createFileRoute('/car')({
  component: CarRoute,
});

function CarRoute() {
  useDeactivateFrames();
  return <CarPage />;
}
