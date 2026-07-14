import { createFileRoute, redirect } from '@tanstack/react-router';
import { SessionListPage } from '../shell/SessionListPage';
import { useDeactivateFrames } from '../shell/useIframeView';
import { DESKTOP_QUERY } from '../shell/useMediaQuery';

/**
 * Mobile-only full-page terminal switcher — reached by tapping the Chat
 * dash-tab while already on /chat (see TopTabs). Same guard as /chat:
 * desktop has the terminal docked with its own SessionBar, and public
 * visitors aren't served the terminal at all, so both bounce to '/'.
 */
export const Route = createFileRoute('/sessions')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    const isDesktop = window.matchMedia(DESKTOP_QUERY).matches;
    const isPublic = window.VIEW_MODE === 'public';
    if (isDesktop || isPublic) throw redirect({ to: '/' });
  },
  component: SessionsRoute,
});

function SessionsRoute() {
  useDeactivateFrames();
  return <SessionListPage />;
}
