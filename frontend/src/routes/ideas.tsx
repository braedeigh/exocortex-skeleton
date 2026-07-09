import { createFileRoute } from '@tanstack/react-router';
import { IdeasPage } from '../features/ideas/IdeasPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The Ideas tab: every page's idea notes grouped by page, then the IDEAS.md
// vision doc as collapsible section cards. Port of legacy /tab/ideas.
export const Route = createFileRoute('/ideas')({
  component: IdeasRoute,
});

function IdeasRoute() {
  useDeactivateFrames();
  return <IdeasPage />;
}
