import { createFileRoute } from '@tanstack/react-router';
import { ThreadsPage } from '../features/threads/ThreadsPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The dedicated Threads view — where the journal rail's Threads button lands.
export const Route = createFileRoute('/threads')({
  component: ThreadsRoute,
});

function ThreadsRoute() {
  useDeactivateFrames();
  return <ThreadsPage />;
}
