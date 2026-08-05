import { createFileRoute } from '@tanstack/react-router';
import { SqlLabPage } from '../features/sqlab/SqlLabPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Read-only SQL console over exo.db (routes/sqlab.py) — reachable from the
// More sheet, not a dashboard tab.
export const Route = createFileRoute('/sql')({
  component: SqlRoute,
});

function SqlRoute() {
  useDeactivateFrames();
  return <SqlLabPage />;
}
