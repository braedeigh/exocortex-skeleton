import { TAB_META, VALID_TABS, TAB_ROUTES, VIEW_META } from '../tabs';

/**
 * panelDestinations.ts — the menu of pages a tile can be pointed at.
 *
 * Assembled from what the app already knows about itself rather than typed out
 * again: the dashboard tabs and their routes (tabs.ts), the non-tab views from
 * the More sheet, and the handful of pages that only ever existed as
 * destinations you land on — the terrain rooms, the code reader, the
 * observatory. Grouped, because a flat list of thirty pages is a wall.
 *
 * Adding a page to tabs.ts puts it in this menu automatically. A page that
 * lives nowhere but here goes in EXTRA below.
 *
 * Touches: PanelFrame.tsx (renders the menu), tabs.ts (most of the content).
 */

export interface Destination {
  label: string;
  icon: string;
  url: string;
}

export interface DestinationGroup {
  group: string;
  items: Destination[];
}

/** Pages that aren't dashboard tabs and aren't in the More sheet — the ones
 *  you normally arrive at by clicking something rather than by navigating. */
const EXTRA: DestinationGroup = {
  group: 'Work',
  items: [
    { label: 'Terrain map', icon: '🗺', url: '/terrain/map' },
    { label: 'Code', icon: '📄', url: '/code' },
    { label: 'Observatory', icon: '🔭', url: '/observatory' },
    { label: 'Threads', icon: '🧵', url: '/threads' },
    { label: 'Scratchpad', icon: '✏️', url: '/scratchpad' },
    { label: 'SQL lab', icon: '🗃', url: '/sql' },
  ],
};

export const DESTINATIONS: DestinationGroup[] = [
  EXTRA,
  {
    group: 'Views',
    items: VIEW_META.map((v) => ({ label: v.label, icon: v.icon, url: v.to })),
  },
  {
    group: 'Dashboard',
    items: VALID_TABS.map((t) => ({
      label: TAB_META[t].label,
      icon: TAB_META[t].icon,
      url: TAB_ROUTES[t],
    })),
  },
];

/**
 * A short name for whatever a tile is currently showing. Matches on the path
 * only, so /code?repo=…&path=… still reads as "Code" rather than falling back
 * to the raw address — the tile header has room for a name, not a query
 * string.
 */
export function destinationLabel(url: string): string {
  const path = url.split('?')[0].replace(/\/$/, '') || '/';
  for (const g of DESTINATIONS) {
    for (const d of g.items) {
      if (d.url === path) return d.label;
    }
  }
  // An unlisted page (a session, a person, a file) — the last path segment is
  // a better guess at its name than the whole address.
  const last = path.split('/').filter(Boolean).pop();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : 'Page';
}
