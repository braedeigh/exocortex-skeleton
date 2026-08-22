import { createFileRoute, redirect } from '@tanstack/react-router';
import { WikiPond } from '../features/wikipond/WikiPond';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /wiki/pond — everything tagged, drawn the way the journal pond draws her
 * words: one column per day, a lane per family (journal, research, build,
 * todo), a rail of tags down the left to light.
 *
 * Un-nested (the `wiki_.` prefix), same trick terrain_.pond.tsx uses for the
 * journal pond: this route owns the whole screen rather than nesting inside
 * /wiki's layout, and a "← Wiki" link (in WikiPond.tsx) walks back. Reads
 * GET /api/wiki/pond (routes/wiki.py) — see docs/tags-architecture.md for
 * the full contract.
 *
 * Guarded the same way /terrain/pond is, even though /wiki itself isn't:
 * unlike the rest of the wiki (a curated "about her" front, safe for public
 * view), the `journal` family here is the same raw card bodies the private
 * pond shows — this page must never render in public view either. Not
 * called out in the design doc; a deliberate call made here because leaving
 * it open would have been the unsafe default.
 */
export const Route = createFileRoute('/wiki_/pond')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/wiki' });
  },
  component: WikiPondRoute,
});

function WikiPondRoute() {
  useDeactivateFrames();
  return <WikiPond />;
}
