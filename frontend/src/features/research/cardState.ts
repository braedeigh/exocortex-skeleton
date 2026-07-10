/**
 * cardState.ts — collapsible-card open/closed memory, per data-card id, under
 * the same localStorage key the legacy page used ('rsrch-open-cards') so
 * state survives the migration.
 */

const KEY = 'rsrch-open-cards';

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function readCardOpen(cardId: string, fallback: boolean): boolean {
  const map = readMap();
  return cardId in map ? !!map[cardId] : fallback;
}

export function writeCardOpen(cardId: string, open: boolean): void {
  try {
    const map = readMap();
    map[cardId] = open;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // storage full/blocked — open state just won't persist
  }
}
