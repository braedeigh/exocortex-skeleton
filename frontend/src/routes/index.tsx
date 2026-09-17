import { createFileRoute, redirect } from '@tanstack/react-router';
import { PublicLanding } from '../shell/PublicLanding';
import { useDeactivateFrames } from '../shell/useIframeView';
import { DESKTOP_QUERY } from '../shell/useMediaQuery';

/**
 * "/" — authed users go straight to /todos. Public visitors:
 *   - desktop: also /todos — the FakeTerminal intro is already docked in
 *     SplitLayout's left pane, so the front door IS the (frosted) dashboard,
 *     exactly like the old split.html public mode.
 *   - mobile: the PublicLanding (full-bleed FakeTerminal + explore/sign-in),
 *     since there's no split pane to carry the intro.
 * The breakpoint is read once per navigation, not reactively — crossing 769px
 * while parked on "/" is rare enough that a reload/renavigation covering it
 * is fine (the old site behaved the same way).
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (
      typeof window !== 'undefined' &&
      window.VIEW_MODE === 'public' &&
      !window.matchMedia(DESKTOP_QUERY).matches
    ) {
      return;
    }
    // The public-only mirror is the portfolio: its front door is the Terrain
    // map, with the about pane docked beside it (SplitLayout / AboutPane).
    if (typeof window !== 'undefined' && window.VIEW_MODE === 'public' && window.PUBLIC_ONLY) {
      throw redirect({ to: '/terrain/map' });
    }
    throw redirect({ to: '/todos' });
  },
  component: Index,
});

function Index() {
  useDeactivateFrames();
  return <PublicLanding />;
}
