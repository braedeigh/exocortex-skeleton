import { createFileRoute } from '@tanstack/react-router';
import { TerrainPage } from '../features/terrain/TerrainPage';
import type { CodeFileSearch } from '../features/terrain/codeFileSearch';
import { MENTIONS_PATTERN } from '../features/terrain/codeMentions';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/map — the file-tree heatmap itself: where the observatory's
 * sessions have been working, files glowing ember by recency. This is where
 * /terrain lands (it's a bare redirect here), and the page the other rooms'
 * "← Terrain" buttons return to.
 *
 * Un-nested (the `terrain_.` prefix) like the other terrain rooms: each is a
 * whole page, not a panel inside a parent — the rooms index on this map is
 * how you walk between them.
 *
 * Public since 2026-09-17 — the one Terrain room a visitor can enter
 * (public_config.PUBLIC_PATHS). It surfaces repo structure and session
 * titles, and the owner decided that's fine; what a visitor can't do is READ
 * a personal file (the server answers 403, the code window says "private")
 * or reach the roster, flow, traces or the other rooms — TerrainPage's
 * `visitor` flag turns those off on the page, the server gate is the lock.
 */
export const Route = createFileRoute('/terrain_/map')({
  // `?journey=<id>` opens the map with that capture ready to replay (the
  // Wiring room links here).
  // `?embed=1` is the chrome-less view for the portfolio page's <iframe>
  // (shell/embed.ts, TerrainPage's `embed`). Kept in the search schema so the
  // router preserves it across its own navigations.
  // `?repo=…&file=…` is the file open over the map, with `mentions`/`of` when
  // it was opened from a table's card (features/terrain/codeFileSearch.ts).
  // In the address so a refresh keeps the file open and the pane's × is a
  // real "back". A file without its repo (or the reverse) means nothing, so
  // the pair is kept or dropped together; mentions only ride with a file.
  // `?solo=1` is the map as the only pane in its tab — where a popped-out
  // file's × lands (shell/solo.ts reads it off the URL, the route never
  // does). Kept in the schema for the same reason `embed` is.
  validateSearch: (raw: Record<string, unknown>): { journey?: string; embed?: boolean; solo?: boolean } & CodeFileSearch => {
    const hasFile = typeof raw.repo === 'string' && raw.repo !== '' && typeof raw.file === 'string' && raw.file !== '';
    // The router parses a bare `mentions=4` as the number 4, so accept both.
    const mentions = typeof raw.mentions === 'number' ? String(raw.mentions) : raw.mentions;
    const hasMentions = hasFile && typeof mentions === 'string' && MENTIONS_PATTERN.test(mentions);
    return {
      ...(typeof raw.journey === 'string' && raw.journey ? { journey: raw.journey } : {}),
      ...(raw.embed === '1' || raw.embed === 1 || raw.embed === true ? { embed: true } : {}),
      ...(raw.solo === '1' || raw.solo === 1 || raw.solo === true ? { solo: true } : {}),
      ...(hasFile ? { repo: raw.repo as string, file: raw.file as string } : {}),
      ...(hasMentions ? { mentions: mentions as string } : {}),
      ...(hasMentions && typeof raw.of === 'string' ? { of: raw.of } : {}),
    };
  },
  component: TerrainRoute,
});

function TerrainRoute() {
  useDeactivateFrames();
  return <TerrainPage />;
}
