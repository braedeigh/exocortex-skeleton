import { createFileRoute, redirect } from '@tanstack/react-router';
import { WorkshopPage } from '../features/workshop/WorkshopPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/workshop?agent=… — an agent's desk: every file it's been writing
 * open at once, the newest as a big readable hero, the rest as portholes,
 * live-updating as edits land (features/workshop/WorkshopPage.tsx).
 *
 * Lives under /terrain with the other rooms — the terrain is where the
 * system looks at itself, and this is watching one agent's hands. The agent
 * travels in ?agent=, so a particular desk is a deep link. Un-nested
 * (`terrain_.` prefix), "← Terrain" walks back; same auth guard as the map —
 * it shows repo source, so public visitors bounce to '/'.
 */
export interface WorkshopSearch {
  /** Conversation id whose desk to stand at. Absent = the agent picker. */
  agent?: string;
}

export const Route = createFileRoute('/terrain_/workshop')({
  validateSearch: (search: Record<string, unknown>): WorkshopSearch => ({
    agent: typeof search.agent === 'string' && search.agent !== '' ? search.agent : undefined,
  }),
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: WorkshopRoute,
});

function WorkshopRoute() {
  useDeactivateFrames();
  const { agent } = Route.useSearch();
  return <WorkshopPage agent={agent} />;
}
