import { createFileRoute } from '@tanstack/react-router';
import { BodyPage } from '../features/body/BodyPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Body tab — native port of /tab/body (symptom tracker, food log, triage,
// sensitivities, experiments). Replaces the legacy iframe at /legacy/body.
export const Route = createFileRoute('/body')({
  component: BodyRoute,
});

function BodyRoute() {
  useDeactivateFrames();
  return <BodyPage />;
}
