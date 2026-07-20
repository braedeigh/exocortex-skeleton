import { createFileRoute } from '@tanstack/react-router';
import { ThreadJournalPage } from '../features/threads/ThreadJournalPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The single-thread journal view — "Open full thread" from the Threads page
// / journal's ThreadPopover lands here. The `threads_.` filename un-nests it
// from /threads (threads.tsx renders no <Outlet/>, so a nested child would
// never appear) — same trick as todos_.editor.tsx.
export const Route = createFileRoute('/threads_/$slug')({
  component: ThreadJournalRoute,
});

function ThreadJournalRoute() {
  useDeactivateFrames();
  const { slug } = Route.useParams();
  // Remount on slug change so per-thread UI state never bleeds between threads.
  return <ThreadJournalPage key={slug} slug={slug} />;
}
