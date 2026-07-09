import { createFileRoute } from '@tanstack/react-router';
import { MediaPage } from '../features/media/MediaPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// MEDIA tab — books/movies/shows backlog, native port of the legacy
// /tab/media page (templates/index.html #tab-media + static/js/media.js).
export const Route = createFileRoute('/media')({
  component: MediaRoute,
});

function MediaRoute() {
  useDeactivateFrames();
  return <MediaPage />;
}
