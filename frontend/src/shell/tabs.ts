/**
 * The 14 legacy dashboard tabs still served by Flask at /tab/<name>
 * (routes/shell.py). Order matches KNOWN_TABS in templates/split.html:1454.
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
};

/** Non-legacy view routes offered from the More sheet, alongside the remaining tabs. */
export const VIEW_META = [
  { key: 'journal', label: 'Journal', icon: '📓', to: '/journal' },
  { key: 'research', label: 'Research', icon: '🔎', to: '/research' },
  { key: 'settings', label: 'Settings', icon: '⚙️', to: '/settings' },
  { key: 'files', label: 'Files', icon: '🗂️', to: '/files' },
] as const;
