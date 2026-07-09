/**
 * byPage.ts — pure logic for the "ideas sorted by page" half of the Ideas
 * tab, ported from static/js/ideas.js (IDEAS_TAB_ORDER / IDEAS_TAB_LABELS /
 * _ideasTabLabel and the visible-tabs computation in renderIdeasByPage).
 */

export const IDEAS_TAB_ORDER = [
  'general',
  'today',
  'kitchen',
  'map',
  'body',
  'money',
  'movement',
  'inventory',
  'meditation',
  'media',
  'car',
  'ideas',
] as const;

export const IDEAS_TAB_LABELS: Record<string, string> = {
  general: 'General',
  today: 'To Do',
  kitchen: 'Kitchen',
  map: 'Life Map',
  body: 'Body',
  money: 'Money',
  movement: 'Movement',
  inventory: 'Inventory',
  meditation: 'Meditation',
  media: 'Media',
  car: 'Car',
  ideas: 'Ideas page',
  global: 'Global',
};

export function ideasTabLabel(tab: string): string {
  return IDEAS_TAB_LABELS[tab] || tab.charAt(0).toUpperCase() + tab.slice(1);
}

/**
 * Which page cards to show: the known order first, then any other tab that
 * has notes, appended in the order the store returned them. 'general' always
 * shows (it holds the add box); every other tab only shows when non-empty.
 */
export function visibleIdeaTabs(all: Record<string, readonly unknown[]> | undefined): string[] {
  const tabs = all ?? {};
  return [...new Set([...IDEAS_TAB_ORDER, ...Object.keys(tabs)])].filter(
    (t) => t === 'general' || (tabs[t] || []).length > 0,
  );
}
