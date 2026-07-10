import { createFileRoute } from '@tanstack/react-router';
import { VscodePage } from '../features/vscode/VscodePage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Native port of templates/vscode_launcher.html (/vscode): memory gauge +
// start/stop for the in-browser code-server. Once running it leaves the SPA
// with a full navigation to /files/ (the code-server reverse proxy — the
// trailing slash matters; this is not the SPA /files route).
export const Route = createFileRoute('/vscode')({
  component: VscodeRoute,
});

function VscodeRoute() {
  useDeactivateFrames();
  return <VscodePage />;
}
