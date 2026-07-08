import { createRootRoute, Outlet } from '@tanstack/react-router';
import { TabBar } from '../shell/TabBar';
import { FrameHost } from '../shell/FrameHost';
import { useFrameBridge } from '../shell/frameBridge';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  useFrameBridge();

  return (
    <>
      <main style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <FrameHost />
        <Outlet />
      </main>
      <TabBar />
    </>
  );
}
