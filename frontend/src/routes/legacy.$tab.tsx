import { createFileRoute, redirect } from '@tanstack/react-router';
import { useActivateFrame } from '../shell/useIframeView';
import { isValidTab } from '../shell/tabs';

export const Route = createFileRoute('/legacy/$tab')({
  beforeLoad: ({ params }) => {
    if (!isValidTab(params.tab)) {
      throw redirect({ to: '/legacy/$tab', params: { tab: 'today' } });
    }
  },
  component: LegacyTab,
});

/**
 * Strangler bridge: renders an unported Flask tab full-bleed under the tab
 * bar via a same-origin iframe (kept mounted once visited — see FrameHost),
 * so the whole app can be routed through the SPA shell before every tab has
 * a native React implementation.
 */
function LegacyTab() {
  const { tab } = Route.useParams();
  useActivateFrame(`legacy:${tab}`, `/tab/${tab}`, tab);
  return null;
}
