import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /terrain/map — the address of the Map room (the box-and-arrow map of a
 * codebase). Until 2026-10-02 this address was the file heatmap, which is
 * now Files at /terrain/files (routes/terrain_.files.tsx).
 *
 * Old links must keep working. Bookmarks, the portfolio page's
 * `?embed=1` iframe, a file link with `?repo=&file=`: anything that came here
 * meaning the heatmap is forwarded to /terrain/files with its search intact.
 * The forward is a replace, so "back" never lands on this hop. Files' own
 * search schema keeps what it understands and drops the rest.
 *
 * The Map room itself is still being built, so for now this forwards
 * everyone. When it lands, it narrows the forward to the cases that mean
 * Files: a visitor (the Map is owner-only, and Files is the page a visitor
 * can open) and any search key only Files understands: embed, solo,
 * journey, build, repo, file, mentions, of.
 */

export const Route = createFileRoute('/terrain_/map')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/terrain/files', search: search as never, replace: true });
  },
  component: () => null,
});
