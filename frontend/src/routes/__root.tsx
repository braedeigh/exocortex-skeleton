import { createRootRoute, Outlet } from '@tanstack/react-router';
import { ApprovalsHost } from '../features/approvals';
import { TopTabs } from '../shell/TopTabs';
import { SplitLayout } from '../shell/SplitLayout';
import { SessionsProvider } from '../shell/SessionsContext';
import { ScrollTopStrip } from '../shell/ScrollTopStrip';
import { useFrameBridge } from '../shell/frameBridge';
import { useDocScrollLock } from '../shell/useDocScrollLock';
import { useMediaQuery, DESKTOP_QUERY } from '../shell/useMediaQuery';

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Shell root: terminal | right pane (desktop split, SplitLayout), where the
 * right pane is TopTabs (flex-shrink 0, top of pane — modeled on the old
 * dashboard's #tab-selector row) stacked above a content host that fills the
 * rest of the pane. FrameHost (absolute inset:0) and the router Outlet share
 * that content host so both iframe-hosted legacy tabs and native routes lay
 * out under the same tab strip.
 *
 * No bottom bar anymore — body{overflow:hidden} (index.css) plus this
 * flex chain (#root -> main -> SplitLayout -> content host, all
 * flex:1/min-height:0) pins the terminal and keeps only the content host
 * scrollable, so native routes (e.g. /todos) scroll inside themselves
 * instead of the whole page scrolling and leaving blank space below.
 *
 * SessionsProvider wraps TopTabs + Outlet (not just the /chat route) so the
 * mobile Chat tab's label and the /chat route's session switcher share one
 * live useSessions() instance — see SessionsContext.tsx. Only enabled on
 * mobile+authed: desktop already gets its own instance inside SplitLayout
 * for the terminal pane, and public visitors get neither (mirrors
 * SplitLayout's own `isDesktop && !isPublic` gate).
 */
function RootLayout() {
  useFrameBridge();
  // The document must never stay scrolled (body{overflow:hidden}, panes
  // scroll internally) — enforce it (see useDocScrollLock).
  useDocScrollLock();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';

  return (
    <main style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <ScrollTopStrip />
      <SplitLayout>
        <SessionsProvider enabled={!isDesktop && !isPublic}>
          <TopTabs />
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
        </SessionsProvider>
      </SplitLayout>
    </main>
  );
}
