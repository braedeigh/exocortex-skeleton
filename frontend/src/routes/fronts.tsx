import { createFileRoute } from '@tanstack/react-router';
import { FrontsOverviewPage } from '../features/fronts/FrontsOverviewPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The Fronts overview: every front in the shared vocabulary drawn at the size
// of what it's currently carrying, counted across to-dos, threads, the buy
// list and research topics. Tapping one opens /todos filtered to that front.
export const Route = createFileRoute('/fronts')({
  component: FrontsRoute,
});

function FrontsRoute() {
  useDeactivateFrames();
  return <FrontsOverviewPage />;
}
