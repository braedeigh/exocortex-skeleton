import { createRootRoute, Outlet } from '@tanstack/react-router';
import { TopTabs } from '../shell/TopTabs';
import { FrameHost } from '../shell/FrameHost';
import { SplitLayout } from '../shell/SplitLayout';
import { useFrameBridge } from '../shell/frameBridge';

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
 */
function RootLayout() {
  useFrameBridge();

  return (
    <main style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <SplitLayout>
        <TopTabs />
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          <FrameHost />
          <Outlet />
        </div>
      </SplitLayout>
    </main>
  );
}
