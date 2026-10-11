import { createFileRoute } from '@tanstack/react-router';
import { AutomationsPage } from '../features/automations/AutomationsPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// The app-visible registry of recurring scheduled runs (routes/automations.py) —
// what runs, when it last ran, whether it succeeded, and a way to pause it.
export const Route = createFileRoute('/automations')({
  component: AutomationsRoute,
});

function AutomationsRoute() {
  useDeactivateFrames();
  return <AutomationsPage />;
}
