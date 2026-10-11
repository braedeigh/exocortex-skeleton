/**
 * axes.ts — the two disclosure axes (pure lookup tables + label helpers),
 * ported from static/js/ecosystem.js. Dot COLOR = transparency (how disclosed
 * the origin is); dot SHAPE (crisp vs soft circle vs outline) = precision;
 * geo_source = how the dot itself got placed.
 */
import type { EcoSource, Transparency, GeoSourceKind, OriginKind } from './types';

/** Fallback / draft-pin green. */
export const ECO_COLOR = '#2f9e7f';

export interface TxInfo {
  color: string;
  label: string;
  blurb: string;
}

export const ECO_TX: Record<Transparency, TxInfo> = {
  disclosed: { color: '#2f9e7f', label: 'disclosed', blurb: 'named / certified / confirmed' },
  partial: { color: '#e0a82e', label: 'partial', blurb: 'country known, not the farm' },
  opaque: { color: '#d4554a', label: 'opaque', blurb: 'nothing disclosed' },
  unrated: { color: '#9aa0a6', label: 'unrated', blurb: 'not researched yet' },
};

/** Most → least Proper. */
export const ECO_TX_ORDER: Transparency[] = ['disclosed', 'partial', 'opaque', 'unrated'];

/** Normalize any stored transparency value to a known level. */
export function txOf(s: Pick<EcoSource, 'transparency'> | null | undefined): Transparency {
  const v = s?.transparency;
  return v && v in ECO_TX ? (v as Transparency) : 'unrated';
}

export function txInfo(s: Pick<EcoSource, 'transparency'> | null | undefined): TxInfo {
  return ECO_TX[txOf(s)];
}

export interface GeoSourceInfo {
  icon: string;
  label: string;
  blurb: string;
}

export const ECO_GEO: Record<GeoSourceKind, GeoSourceInfo> = {
  placed: { icon: '📍', label: 'placed', blurb: 'exact spot I chose — a claim about this item' },
  proxy: { icon: '≈', label: 'USDA proxy', blurb: 'where this is generally grown — not necessarily this item' },
  guess: { icon: '~', label: 'rough guess', blurb: 'eyeballed a rough region' },
  unrated: { icon: '·', label: 'unset', blurb: "how the dot was placed isn't marked" },
};

/** The three settable choices (unrated is only ever a default). */
export const ECO_GEO_ORDER: GeoSourceKind[] = ['placed', 'proxy', 'guess'];

export function geoSourceOf(s: Pick<EcoSource, 'geo_source'> | null | undefined): GeoSourceKind {
  const v = s?.geo_source;
  return v && v in ECO_GEO ? (v as GeoSourceKind) : 'unrated';
}

export function geoSourceInfo(s: Pick<EcoSource, 'geo_source'> | null | undefined): GeoSourceInfo {
  return ECO_GEO[geoSourceOf(s)];
}

/** Is this an "area" source drawn as real county/state outlines (vs a circle)? */
export function isShapeSource(
  s: Pick<EcoSource, 'precision' | 'area_kind'> | null | undefined,
): boolean {
  return !!s && s.precision === 'area' && (s.area_kind === 'counties' || s.area_kind === 'state');
}

/** A short human label for what a source's footprint is. */
export function metaLabel(s: EcoSource): string {
  if (s.precision === 'area' && s.area_kind === 'counties') {
    const n = new Set(s.counties || []).size;
    return n + (n === 1 ? ' county' : ' counties') + ' (USDA)';
  }
  if (s.precision === 'area' && s.area_kind === 'state') return (s.region_name || 'state') + ' (state)';
  if (s.precision === 'area' && (s.radius_km || 0) > 0) return '~' + Math.round(s.radius_km || 0) + ' km region';
  return 'exact spot';
}

/** List order: transparency rank (most → least Proper), then name. */
export function compareSources(a: EcoSource, b: EcoSource): number {
  const ra = ECO_TX_ORDER.indexOf(txOf(a));
  const rb = ECO_TX_ORDER.indexOf(txOf(b));
  if (ra !== rb) return ra - rb;
  return String(a.name).localeCompare(String(b.name));
}

/** Where a source's placement information came from — the fourth thing a
 * source says, beside the three axes. Short labels for chips; the long
 * meanings come from the server (eco_origins, sourcestore.ORIGINS). */
export const ECO_ORIGIN: Record<OriginKind, { label: string; icon: string }> = {
  'usda-nass': { label: 'USDA NASS', icon: '🌾' },
  geocoded: { label: 'Address lookup', icon: '📫' },
  package: { label: 'Package / brand', icon: '🏷' },
  visit: { label: 'In person', icon: '🧺' },
  research: { label: 'Research', icon: '📄' },
  hand: { label: 'By hand', icon: '✋' },
  unknown: { label: 'Not recorded', icon: '·' },
};

export const ECO_ORIGIN_ORDER: OriginKind[] = [
  'usda-nass', 'geocoded', 'package', 'visit', 'research', 'hand', 'unknown',
];

export function originOf(s: Pick<EcoSource, 'origin'> | null | undefined): OriginKind {
  const v = (s?.origin || '') as OriginKind;
  return v in ECO_ORIGIN ? v : 'unknown';
}

/** A USDA county figure as a reader wants it: "1,204,000 HEAD". */
export function countyFigure(value: number | null | undefined, unit: string | undefined): string {
  if (typeof value !== 'number') return '';
  return `${Math.round(value).toLocaleString()}${unit ? ' ' + unit : ''}`;
}
