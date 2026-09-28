import { createFileRoute, redirect } from '@tanstack/react-router';
import { TranscriptsPond } from '../features/transcripts/TranscriptsPond';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /transcripts — imported chatbot history, drawn as a pond and sorted by topic.
 *
 * Its own top-level page rather than a Terrain room: the organizer is meant to
 * ship beside Terrain as a separate piece, so it doesn't live inside the
 * terrain's rooms. Same auth guard as the journal pond — it shows someone's
 * private conversations, so it must never render in public view.
 */
export const Route = createFileRoute('/transcripts')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TranscriptsRoute,
});

function TranscriptsRoute() {
  useDeactivateFrames();
  return <TranscriptsPond />;
}
