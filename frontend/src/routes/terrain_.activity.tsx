import { createFileRoute, redirect } from '@tanstack/react-router';
import { ActivityPage } from '../features/activity/ActivityPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/activity?agent=… — one session's work, step by step, live: every
 * tool call with its input and output, and whatever made a turn stall or
 * fail (features/activity/ActivityPage.tsx).
 *
 * A room under /terrain beside the Workshop, and the same shape: the session
 * travels in ?agent=, so a particular session's activity is a deep link and
 * can sit in any workspace panel. It deliberately isn't under /observatory:
 * the workspace treats any /observatory page carrying a session id as that
 * conversation (shell/panels/sections.ts convIdOf), and this page must not
 * be mistaken for a second copy of it. Public visitors bounce to '/'; it
 * shows commands and file contents.
 */
export interface ActivitySearch {
  /** Conversation id whose activity to show. Absent = the session picker. */
  agent?: string;
}

export const Route = createFileRoute('/terrain_/activity')({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => ({
    agent: typeof search.agent === 'string' && search.agent !== '' ? search.agent : undefined,
  }),
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ActivityRoute,
});

function ActivityRoute() {
  useDeactivateFrames();
  const { agent } = Route.useSearch();
  return <ActivityPage agent={agent} />;
}
