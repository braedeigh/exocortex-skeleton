import { createFileRoute } from '@tanstack/react-router';
import { MovementPage } from '../features/movement/MovementPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Movement tab — routines of moves with inline demo videos, natively ported
// from the legacy /tab/movement (movement.js).
export const Route = createFileRoute('/movement')({
  component: MovementRoute,
});

function MovementRoute() {
  useDeactivateFrames();
  return <MovementPage />;
}
