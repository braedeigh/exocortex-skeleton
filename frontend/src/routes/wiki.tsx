import { createFileRoute } from '@tanstack/react-router';
import { WikiHome } from '../features/wiki/WikiHome';
import { useDeactivateFrames } from '../shell/useIframeView';

// The wiki front door (/wiki) — GET /api/wiki/home rendered as a short
// landing page, meant to be walked deeper via its links (see WikiHome.tsx).
export const Route = createFileRoute('/wiki')({
  component: WikiRoute,
});

function WikiRoute() {
  useDeactivateFrames();
  return <WikiHome />;
}
