import { createFileRoute } from '@tanstack/react-router';
import { PersonalityPage } from '../features/personality/PersonalityPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The goal-personality.md doc as ## section cards with a read/edit detail
// view. Port of the standalone legacy /personality page.
export const Route = createFileRoute('/personality')({
  component: PersonalityRoute,
});

function PersonalityRoute() {
  useDeactivateFrames();
  return <PersonalityPage />;
}
