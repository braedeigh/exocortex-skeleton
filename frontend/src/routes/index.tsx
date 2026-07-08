import { createFileRoute, redirect } from '@tanstack/react-router';
import { PublicLanding } from '../shell/PublicLanding';
import { useDeactivateFrames } from '../shell/useIframeView';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') return;
    throw redirect({ to: '/todos' });
  },
  component: Index,
});

function Index() {
  useDeactivateFrames();
  return <PublicLanding />;
}
