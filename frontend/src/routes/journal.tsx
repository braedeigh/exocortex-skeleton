import { createFileRoute } from '@tanstack/react-router';
import { IframeRoute } from '../shell/IframeRoute';

export const Route = createFileRoute('/journal')({
  component: () => <IframeRoute frameKey="journal" src="/journal-view" title="Journal" />,
});
