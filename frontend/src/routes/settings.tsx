import { createFileRoute } from '@tanstack/react-router';
import { IframeRoute } from '../shell/IframeRoute';

export const Route = createFileRoute('/settings')({
  component: () => <IframeRoute frameKey="settings" src="/settings-view" title="Settings" />,
});
