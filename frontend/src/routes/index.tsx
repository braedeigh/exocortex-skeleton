import { createFileRoute, redirect } from '@tanstack/react-router';
import { PublicLanding } from '../shell/PublicLanding';
import { LauncherPage } from '../features/launcher/LauncherPage';
import { isStandalone } from '../shell/standalone';
import { useDeactivateFrames } from '../shell/useIframeView';
import { DESKTOP_QUERY } from '../shell/useMediaQuery';

/**
 * "/" — signed in, the launcher: one card per app (features/launcher, the
 * apps in apps.json). There is no everything-app to land in any more. The
 * desktop app (standalone) is sent home by the root route before this runs.
 * Public visitors:
 *   - desktop, or the public-only mirror: the Terrain map (see beforeLoad).
 *   - mobile: the PublicLanding (full-bleed FakeTerminal + explore/sign-in),
 *     since there's no split pane to carry the intro.
 * The breakpoint is read once per navigation, not reactively — crossing 769px
 * while parked on "/" is rare enough that a reload/renavigation covering it
 * is fine (the old site behaved the same way).
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') {
      // Since 2026-09-17 the one public page is the Terrain map
      // (public_config.PRESENTABLE_PATHS) — the dashboard is closed to
      // visitors, so "/" goes to the map. On the public-only mirror that is
      // the whole site, every screen size; on the private site's logged-out
      // view a phone still gets the FakeTerminal landing first.
      if (window.PUBLIC_ONLY || window.matchMedia(DESKTOP_QUERY).matches) {
        throw redirect({ to: '/terrain/files' });
      }
      return;
    }
  },
  component: Index,
});

function Index() {
  useDeactivateFrames();
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
  return isPublic || isStandalone() ? <PublicLanding /> : <LauncherPage />;
}
