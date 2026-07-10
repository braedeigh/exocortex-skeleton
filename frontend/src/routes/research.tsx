import { createFileRoute } from '@tanstack/react-router';
import { ResearchPage } from '../features/research/ResearchPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /research — native port of templates/research.html + static/js/research.js
 * (was an iframe to /research-view). The legacy page hash-routed its thread
 * view ('#thread/<id>'); that becomes the ?thread=<id> search param, so old
 * deep links map as:
 *
 *   /research (iframe showing /research-view, hash '')  ->  /research
 *   /research-view#thread/<id>                          ->  /research?thread=<id>
 */

export interface ResearchSearch {
  thread?: string;
}

export const Route = createFileRoute('/research')({
  component: ResearchRoute,
  validateSearch: (search: Record<string, unknown>): ResearchSearch => ({
    thread: typeof search.thread === 'string' && search.thread ? search.thread : undefined,
  }),
});

function ResearchRoute() {
  useDeactivateFrames();
  return <ResearchPage />;
}
