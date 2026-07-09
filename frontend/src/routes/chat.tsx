import { createFileRoute, redirect } from '@tanstack/react-router';
import { ChatPage } from '../shell/ChatPage';
import { useDeactivateFrames } from '../shell/useIframeView';
import { DESKTOP_QUERY } from '../shell/useMediaQuery';

/**
 * Mobile-only "Chat" tab (see TopTabs.tsx's dash bar) — desktop already has
 * the terminal permanently docked in the left split pane (SplitLayout), so
 * opening /chat there just bounces back to '/' instead of duplicating it.
 * Public visitors get the same bounce: the terminal isn't served to them
 * server-side either (routes/terminal.py's /phone, /api/sessions aren't in
 * PUBLIC_PATHS), mirroring SplitLayout's own `isDesktop && !isPublic` gate.
 */
export const Route = createFileRoute('/chat')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    const isDesktop = window.matchMedia(DESKTOP_QUERY).matches;
    const isPublic = window.VIEW_MODE === 'public';
    if (isDesktop || isPublic) throw redirect({ to: '/' });
  },
  component: ChatRoute,
});

function ChatRoute() {
  useDeactivateFrames();
  return <ChatPage />;
}
