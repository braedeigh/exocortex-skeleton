import { createFileRoute } from '@tanstack/react-router';
import { MeditationPage } from '../features/meditation/MeditationPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Native port of the legacy Meditation tab (templates/index.html
// #tab-meditation + static/js/meditation.js) — replaces /legacy/meditation.
export const Route = createFileRoute('/meditation')({
  component: MeditationRoute,
});

function MeditationRoute() {
  useDeactivateFrames();
  return <MeditationPage />;
}
