import { createFileRoute } from '@tanstack/react-router';
import { RecordingsPage } from '../features/recordings/RecordingsPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Audio recordings and their transcripts — the shelf for captured talk
// (trainings, appointments, voice memos). Backed by routes/recordings.py.
export const Route = createFileRoute('/recordings')({
  component: RecordingsRoute,
});

function RecordingsRoute() {
  useDeactivateFrames();
  return <RecordingsPage />;
}
