import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SudoHost } from '../features/sudo/SudoHost';
import { ApprovalsHost } from '../features/approvals';
import { TopTabs } from '../shell/TopTabs';
import { SplitLayout } from '../shell/SplitLayout';
import { SessionsProvider } from '../shell/SessionsContext';
import { ScrollTopStrip } from '../shell/ScrollTopStrip';
import { useFrameBridge } from '../shell/frameBridge';
import { useDocScrollLock } from '../shell/useDocScrollLock';
import { useMediaQuery, DESKTOP_QUERY } from '../shell/useMediaQuery';
import { useInPanel } from '../shell/panels/panelContext';

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * The router root, which now has to answer a question it never used to: am I
 * the window, or am I a tile inside one?
 *
 * Workspace tiles show a page by running a second router over this same route
 * tree (shell/panels/RoutePanel.tsx). Without the check below, a tile would
 * draw the whole app inside itself — tab strip, workspace, and all — and then
 * do it again inside that. So a tile gets PanelRoot: the page, nothing else.
 *
 * The two are separate components rather than one with an `if`, because each
 * runs its own hooks and only the window's should run once per window. Mounting
 * the approvals queue, the frame bridge, or the scroll lock once per tile would
 * poll several times over and pop one approval sheet per tile.
 */
function RootLayout() {
  return useInPanel() ? <PanelRoot /> : <WindowRoot />;
}

/** A tile: just the page, filling the tile's body. */
function PanelRoot() {
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <Outlet />
    </div>
  );
}

/**
 * The window itself: the shell as it has always been. On authed desktop
 * SplitLayout hands this content to the workspace as its primary tile — the
 * one the browser URL and the tab strip drive — so everything below is
 * unchanged by panels existing.
 *
 * No bottom bar — body{overflow:hidden} (index.css) plus this flex chain
 * (#root -> main -> SplitLayout -> content host, all flex:1/min-height:0)
 * keeps only the content host scrollable, so native routes scroll inside
 * themselves instead of the whole page scrolling.
 *
 * SessionsProvider wraps TopTabs + Outlet (not just the /chat route) so the
 * mobile Chat tab's label and the /chat route's session switcher share one
 * live useSessions() instance — see SessionsContext.tsx. Only enabled on
 * mobile+authed: desktop gets its own instance inside the reading-room tile,
 * and public visitors get neither.
 */
function WindowRoot() {
  useFrameBridge();
  // The document must never stay scrolled (body{overflow:hidden}, panes
  // scroll internally) — enforce it (see useDocScrollLock).
  useDocScrollLock();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';

  return (
    <main style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <ScrollTopStrip />
      {/* The tab strip is handed over SEPARATELY from the content because on
          authed desktop the workspace puts it INSIDE the primary tile's header
          row rather than above it. Stacking a tile header on top of the tab
          strip meant three rows of chrome saying overlapping things; this way
          the tile's name and its split controls share the row the tabs were
          already using. Mobile and public visitors just get it back on top,
          which is where it always was. */}
      <SessionsProvider enabled={!isDesktop && !isPublic}>
        <SplitLayout chrome={<TopTabs />}>
          <div
            id="content-host"
            style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}
          >
            <Outlet />
          </div>
          {/* Keeper-staged change queue — polls /api/pending, renders nothing
              when empty. Mounted at the root so approvals surface on every
              page (the legacy dashboard polled this globally too). */}
          {!isPublic ? <ApprovalsHost /> : null}
          {/* Agents' sudo requests — the bottom popup with a password box.
              Polls /api/sudo/requests, renders nothing when none are open. */}
          {!isPublic ? <SudoHost /> : null}
        </SplitLayout>
      </SessionsProvider>
    </main>
  );
}
