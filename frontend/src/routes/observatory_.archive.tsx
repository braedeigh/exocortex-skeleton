import { createFileRoute, redirect } from '@tanstack/react-router';
import { ArchivePage } from '../features/observatory/ArchivePage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /observatory/archive — every session a room has ever held, and a box to
 * search inside them.
 *
 * `?lane=personal|coding|orchestra` scopes it to one room. That's how it's
 * always reached in practice: the door is the line under each room on the
 * roster, so arriving already narrowed to the room she was looking at is the
 * whole point. No lane = every room, which is what the page's own "All" chip
 * and the old /atlas bookmark land on.
 *
 * Un-nested (the `observatory_.` prefix) for the same reason
 * observatory_.$botId is: it's a page of its own, not something rendered
 * inside the roster.
 *
 * Auth-only, same guard as the rest of the Observatory — it surfaces session
 * contents, including journalled ones, so public visitors bounce to '/'.
 */
export const Route = createFileRoute('/observatory_/archive')({
  validateSearch: (search: Record<string, unknown>): { lane?: string } =>
    typeof search.lane === 'string' && search.lane ? { lane: search.lane } : {},
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ArchiveRoute,
});

function ArchiveRoute() {
  useDeactivateFrames();
  const { lane } = Route.useSearch();
  return <ArchivePage lane={lane} />;
}
