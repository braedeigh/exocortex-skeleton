import { createFileRoute } from '@tanstack/react-router';
import { FrontRoomPage } from '../features/fronts/room/FrontRoomPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// One front as a room: its to-dos, purchases and context as draggable,
// resizable panels, with the arrangement remembered per front.
export const Route = createFileRoute('/fronts/$frontId')({
  component: FrontRoomRoute,
});

function FrontRoomRoute() {
  useDeactivateFrames();
  const { frontId } = Route.useParams();
  return <FrontRoomPage frontId={frontId} />;
}
