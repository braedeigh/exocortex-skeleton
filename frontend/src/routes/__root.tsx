import { createRootRoute, Outlet } from '@tanstack/react-router';
import { TabBar } from '../shell/TabBar';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <>
      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </main>
      <TabBar />
    </>
  );
}
