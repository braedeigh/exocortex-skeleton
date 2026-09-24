/**
 * The 15 dashboard tabs — all native SPA routes (see TAB_ROUTES). Order
 * matches the old dashboard's tab order; "Legacy" in the type names is
 * historical (the Flask /tab/<name> pages are gone).
 */
export const VALID_TABS = [
  'today',
  'map',
  'kitchen',
  'inventory',
  'money',
  'car',
  'meditation',
  'media',
  'movement',
  'body',
  'ideas',
  'ecosystem',
  'housing',
  'people',
  'travel',
] as const;

export type LegacyTab = (typeof VALID_TABS)[number];

export function isValidTab(tab: string): tab is LegacyTab {
  return (VALID_TABS as readonly string[]).includes(tab);
}

export interface TabMeta {
  key: LegacyTab;
  label: string;
  icon: string;
}

export const TAB_META: Record<LegacyTab, TabMeta> = {
  today: { key: 'today', label: 'Today', icon: '☀' },
  map: { key: 'map', label: 'Map', icon: '🗺' },
  kitchen: { key: 'kitchen', label: 'Kitchen', icon: '🍳' },
  inventory: { key: 'inventory', label: 'Inventory', icon: '📦' },
  money: { key: 'money', label: 'Money', icon: '💰' },
  car: { key: 'car', label: 'Car', icon: '🚗' },
  meditation: { key: 'meditation', label: 'Meditation', icon: '🧘' },
  media: { key: 'media', label: 'Media', icon: '🎬' },
  movement: { key: 'movement', label: 'Movement', icon: '🏃' },
  body: { key: 'body', label: 'Body', icon: '🩺' },
  ideas: { key: 'ideas', label: 'Ideas', icon: '💡' },
  ecosystem: { key: 'ecosystem', label: 'Ecosystem', icon: '🌱' },
  housing: { key: 'housing', label: 'Housing', icon: '🏠' },
  people: { key: 'people', label: 'People', icon: '👥' },
  travel: { key: 'travel', label: 'Travel', icon: '🧳' },
};

/**
 * Where a note came from, in the words the page actually wears.
 *
 * A dev note is filed under a tab key (`today`, `map`), but the page she taps
 * says "Today" and "Map" — and notes also come from surfaces that were never
 * dashboard tabs at all (`journal`, `terminal`, `global`). So: the real label
 * for a known tab, a capitalised fallback for everything else, and never the
 * bare slug. Anything showing a note's origin uses these two, so the same page
 * is named the same way everywhere it appears.
 */
export function tabLabel(tab: string): string {
  if (isValidTab(tab)) return TAB_META[tab].label;
  return tab.length ? tab.charAt(0).toUpperCase() + tab.slice(1) : tab;
}

/** The tab's glyph, or a neutral page mark for the non-tab surfaces. */
export function tabIcon(tab: string): string {
  return isValidTab(tab) ? TAB_META[tab].icon : '◈';
}

/**
 * Native SPA route for each dashboard tab. Every tab is now ported — the
 * /legacy/$tab iframe route remains only as a fallback for old deep links.
 */
export const TAB_ROUTES: Record<LegacyTab, string> = {
  today: '/todos',
  map: '/map',
  kitchen: '/kitchen',
  inventory: '/inventory',
  money: '/money',
  car: '/car',
  meditation: '/meditation',
  media: '/media',
  movement: '/movement',
  body: '/body',
  ideas: '/ideas',
  ecosystem: '/ecosystem',
  housing: '/housing',
  people: '/people',
  travel: '/travel',
};

export function tabForPath(pathname: string): LegacyTab | null {
  for (const tab of VALID_TABS) {
    if (TAB_ROUTES[tab] === pathname) return tab;
  }
  return null;
}

/** Non-legacy view routes offered from the More sheet, alongside the remaining tabs. */
export const VIEW_META = [
  { key: 'journal', label: 'Journal', icon: '📓', to: '/journal' },
  // Research lands on the claims table, the surface she reads; the thread
  // directory is a tap away from it. Prompt: "i want the research UI you
  // made to go in the 'research' tab on the dashboard".
  { key: 'research', label: 'Research', icon: '🔎', to: '/research/claims' },
  { key: 'settings', label: 'Settings', icon: '⚙️', to: '/settings' },
  { key: 'files', label: 'Files', icon: '🗂️', to: '/files' },
  { key: 'notes', label: 'Notes', icon: '📝', to: '/notes' },
  { key: 'build', label: 'Build', icon: '🔨', to: '/build' },
  { key: 'recordings', label: 'Recordings', icon: '🎙️', to: '/recordings' },
] as const;
