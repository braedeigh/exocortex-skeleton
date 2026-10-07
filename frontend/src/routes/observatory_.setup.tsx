import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { FirstRunPage } from '../features/setup/FirstRunPage';
import { isStandalone } from '../shell/standalone';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/setup — the desktop app's first-run screen, opened again from
 * the Setup tab: change the code folder Terrain draws, or re-check Claude
 * Code. It sits under /observatory so the server needs no new address.
 *
 * Desktop app only. The normal site has no setup to do, so there this
 * address goes back to the roster.
 */
export const Route = createFileRoute('/observatory_/setup')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (!isStandalone()) throw redirect({ to: '/observatory' });
  },
  component: SetupRoute,
});

function SetupRoute() {
  useDeactivateFrames();
  const navigate = useNavigate();
  return (
    <FirstRunPage
      returning
      appName={window.APP_META?.name}
      onOpen={() => void navigate({ to: '/terrain/files' })}
    />
  );
}
