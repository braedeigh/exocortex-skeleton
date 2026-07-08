import { createFileRoute } from '@tanstack/react-router';
import { IframeRoute } from '../shell/IframeRoute';

export const Route = createFileRoute('/research')({
  component: () => <IframeRoute frameKey="research" src="/research-view" title="Research" />,
});
