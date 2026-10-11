/**
 * themeColor.ts — which map background to draw, and in which colour.
 *
 * Two questions, answered separately:
 *
 * LIGHT OR DARK is read from --bg's luminance, so it works for auto/sky/light/
 * dark without a body class to watch (sky-theme.js writes the palette as
 * inline styles on documentElement, and EcoMap watches that attribute).
 *
 * WHICH PROVIDER depends on whether a CARTO key is set. CARTO's free basemaps
 * started stamping "API KEY REQUIRED" across every tile in 2026; a key is free
 * and instant, but it's the owner's, so it lives in the gitignored
 * frontend/.env.local as VITE_CARTO_KEY, beside the home coordinates. With no
 * key the map falls back to Esri's gray canvas (base + a labels layer on top),
 * which needs nothing — so a fresh install gets a clean map out of the box,
 * and if CARTO ever changes the rules again, deleting the key is the fix.
 *
 * Pure functions only, so the choice is testable (themeColor.test.ts).
 * Touches: EcoMap.tsx (draws the layers), ownerHome.ts (same env pattern).
 *
 * Prompt that produced it: "currently it says api key required" → "do both"
 * (a CARTO key when present, a keyless fallback when not).
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

/** One raster layer to add to the map, in the order given. */
export interface TileLayerSpec {
  url: string;
  attribution: string;
  subdomains?: string;
  /** Zoom past which Leaflet upscales the last real tile instead of asking
   *  for one that doesn't exist. */
  maxNativeZoom: number;
}

const CARTO_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

const CARTO_STYLE: Record<TileKey, string> = { dark: 'dark_all', light: 'light_all' };
// Esri's canvas is two services: a mute base and a separate labels layer.
// The base alone is very plain, so the labels ride on top.
const ESRI_BASE: Record<TileKey, string> = { dark: 'World_Dark_Gray_Base', light: 'World_Light_Gray_Base' };
const ESRI_LABELS: Record<TileKey, string> = { dark: 'World_Dark_Gray_Reference', light: 'World_Light_Gray_Reference' };

/** The layers to draw for a theme. Pass the CARTO key explicitly so this
 *  stays a pure function; EcoMap reads it from the env (see cartoKey). */
export function tileLayersFor(theme: TileKey, cartoKey: string | undefined): TileLayerSpec[] {
  const key = (cartoKey ?? '').trim();
  if (key) {
    return [
      {
        url: `https://basemaps.cartocdn.com/rastertiles/${CARTO_STYLE[theme]}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
        attribution: CARTO_ATTRIBUTION,
        maxNativeZoom: 19,
      },
    ];
  }
  // Esri tiles are {z}/{y}/{x} — the other way round from everyone else.
  const esri = (service: string) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${service}/MapServer/tile/{z}/{y}/{x}`;
  return [
    { url: esri(ESRI_BASE[theme]), attribution: ESRI_ATTRIBUTION, maxNativeZoom: 16 },
    { url: esri(ESRI_LABELS[theme]), attribution: '', maxNativeZoom: 16 },
  ];
}

/** The owner's CARTO basemaps key, if this install has one. */
export function cartoKey(): string | undefined {
  const v = import.meta.env.VITE_CARTO_KEY;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The tile set the current document theme calls for. */
export function currentTileKey(): TileKey {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  return isDarkColor(bg) ? 'dark' : 'light';
}
