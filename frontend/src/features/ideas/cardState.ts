/**
 * cardState.ts — collapsible-card open/closed memory, sharing the legacy
 * localStorage keys (`mapCardOpen:<card>` = '1'/'0', core.js mapCardToggled /
 * restoreMapCards) so states carry over from the old tab. Cards with no
 * saved value fall back to their default (legacy `data-default-open`).
 */

const PREFIX = 'mapCardOpen:';

export function readCardOpen(card: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + card);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return fallback;
}

export function writeCardOpen(card: string, open: boolean): void {
  try {
    localStorage.setItem(PREFIX + card, open ? '1' : '0');
  } catch {
    // localStorage unavailable — state just won't persist across visits
  }
}
