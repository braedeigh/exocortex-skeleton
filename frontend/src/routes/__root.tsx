import { createRootRoute, Outlet } from '@tanstack/react-router';
import { TopTabs } from '../shell/TopTabs';
import { FrameHost } from '../shell/FrameHost';
import { SplitLayout } from '../shell/SplitLayout';
import { SessionsProvider } from '../shell/SessionsContext';
import { useFrameBridge } from '../shell/frameBridge';
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
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';

  return (
    <main style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <SplitLayout>
        <SessionsProvider enabled={!isDesktop && !isPublic}>
          <TopTabs />
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <FrameHost />
            <Outlet />
          </div>
        </SessionsProvider>
      </SplitLayout>
    </main>
  );
}
