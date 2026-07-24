import { createFileRoute, redirect } from '@tanstack/react-router';
import { RosterPage } from '../features/readingRoom/RosterPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * The bot roster (bot-surface-design §5B) — auth-only on every device: the
 * reading room spawns headless Claude with vault access, so public visitors
 * bounce exactly like /chat and /sessions do.
 */
export const Route = createFileRoute('/reading-room')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ReadingRoomRoute,
});

function ReadingRoomRoute() {
  useDeactivateFrames();
  return <RosterPage />;
}
