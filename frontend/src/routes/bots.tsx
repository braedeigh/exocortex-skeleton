import { createFileRoute, redirect } from '@tanstack/react-router';
import { BotRosterPage } from '../features/bots/BotRosterPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * The bot roster (bot-surface-design §5B) — auth-only on every device: the
 * bot surface spawns headless Claude with vault access, so public visitors
 * bounce exactly like /chat and /sessions do.
 */
export const Route = createFileRoute('/bots')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: BotsRoute,
});

function BotsRoute() {
  useDeactivateFrames();
  return <BotRosterPage />;
}
