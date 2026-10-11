import { createFileRoute } from '@tanstack/react-router';
import { ScratchpadPage } from '../features/scratchpad/ScratchpadPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The quick scratch pad — port of legacy templates/notes.html (Flask /notes).
// Lives at /scratchpad because the SPA's /notes is the notes *browser*; a
// redirect from the old URL is wired up at integration time.
export const Route = createFileRoute('/scratchpad')({
  component: ScratchpadRoute,
});

function ScratchpadRoute() {
  useDeactivateFrames();
  return <ScratchpadPage />;
}
