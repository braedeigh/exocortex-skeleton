import { createFileRoute } from '@tanstack/react-router';
import { BranchesPage } from '../features/branches/BranchesPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// What the agents built and she hasn't taken (routes/branches.py) — reachable
// from the More sheet, alongside SQL, rather than as a dashboard tab.
export const Route = createFileRoute('/branches')({
  component: BranchesRoute,
});

function BranchesRoute() {
  useDeactivateFrames();
  return <BranchesPage />;
}
