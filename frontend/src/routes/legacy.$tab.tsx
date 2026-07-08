import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/legacy/$tab')({
  component: LegacyTab,
});

/**
 * Strangler bridge: renders an unported Flask tab full-bleed under the tab
 * bar via iframe, so the whole app can be routed through the SPA shell
 * before every tab has a native React implementation.
 */
function LegacyTab() {
  const { tab } = Route.useParams();

  return (
    <iframe
      src={`/tab/${tab}`}
      title={tab}
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        border: 'none',
        display: 'block',
      }}
    />
  );
}
