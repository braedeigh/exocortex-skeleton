import { createFileRoute } from '@tanstack/react-router';
import { IframeRoute } from '../shell/IframeRoute';

// split.html's Files tab iframes /keeper (the keeper memory browser) —
// see switchDashView/switchTab's `ff.src = '/keeper'` (templates/split.html:871,1082).
export const Route = createFileRoute('/files')({
  component: () => <IframeRoute frameKey="files" src="/keeper" title="Files" />,
});
