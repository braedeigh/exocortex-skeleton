import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { isEmbed } from '../shell/embed';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /demo/swarm — one real swarm, frozen mid-work, open to anyone
 * (features/observatory/SwarmDemoPage.tsx). It reads only the frozen copy
 * the owner published (routes/swarm_demo.py), never a live session, so
 * unlike /observatory/swarm/<id> it needs no sign-in.
 *
 * `?embed=1` is the EXHIBIT: the same page with no app chrome, built for the
 * portfolio page's <iframe> the same way /food-map?embed=1 is
 * (shell/embed.ts).
 */
const SwarmDemoPage = lazy(() =>
  import('../features/observatory/SwarmDemoPage').then((m) => ({ default: m.SwarmDemoPage })),
);

export const Route = createFileRoute('/demo/swarm')({
  component: SwarmDemoRoute,
});

function SwarmDemoRoute() {
  useDeactivateFrames();
  return (
    <Suspense fallback={null}>
      <SwarmDemoPage embed={isEmbed()} />
    </Suspense>
  );
}
