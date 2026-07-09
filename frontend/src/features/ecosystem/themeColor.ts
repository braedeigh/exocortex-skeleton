/**
 * themeColor.ts — pick the CARTO basemap that matches the current theme by
 * reading --bg's luminance. Works for auto/sky/light/dark without a body class
 * to watch (sky-theme.js writes the palette as inline styles on
 * documentElement, so a MutationObserver on its style attribute catches every
 * change). Pure color math lives here so it's testable.
 */

export function parseColor(s: string | null | undefined): [number, number, number] | null {
  if (!s) return null;
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length < 6) return null;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2]];
  }
  return null;
}

/** True when a CSS color is dark (luminance < 0.5). Unparseable → false (light). */
export function isDarkColor(s: string | null | undefined): boolean {
  const rgb = parseColor((s || '').trim());
  if (!rgb) return false;
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum < 0.5;
}

export type TileKey = 'dark' | 'light';

export const TILE_URLS: Record<TileKey, string> = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

export const TILE_ATTRIBUTION = '&copy; OpenStreetMap &copy; CARTO';

/** The tile set the current document theme calls for. */
export function currentTileKey(): TileKey {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  return isDarkColor(bg) ? 'dark' : 'light';
}
