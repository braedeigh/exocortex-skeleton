import { createFileRoute } from '@tanstack/react-router';
import { WikiThread } from '../features/wiki/WikiThread';
import { useDeactivateFrames } from '../shell/useIframeView';

// The per-thread wiki article (/wiki/<slug>) — GET /api/thread rendered as
// its own page (see WikiThread.tsx). Registered in routes/spa.py too
// (@app.route("/wiki/<slug>") on spa_shell) so a direct hit/refresh resolves
// server-side before React takes over client-side routing.
export const Route = createFileRoute('/wiki/$slug')({
  component: WikiThreadRoute,
});

function WikiThreadRoute() {
  useDeactivateFrames();
  const { slug } = Route.useParams();
  // Remount on slug change so per-thread UI state never bleeds between threads.
  return <WikiThread key={slug} slug={slug} />;
}
