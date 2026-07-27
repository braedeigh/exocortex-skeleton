import { createFileRoute, redirect } from '@tanstack/react-router';
import { RosterPage } from '../features/observatory/RosterPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * The bot roster (bot-surface-design §5B) — auth-only on every device: the
 * observatory spawns headless Claude with vault access, so public visitors
 * bounce exactly like /chat and /sessions do.
 */
export const Route = createFileRoute('/observatory')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ObservatoryRoute,
});

function ObservatoryRoute() {
  useDeactivateFrames();
  return <RosterPage />;
}
