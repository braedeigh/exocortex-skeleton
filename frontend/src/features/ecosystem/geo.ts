/**
 * geo.ts — US county/state boundary GeoJSON, lazy-loaded (the counties file is
 * ~3MB, so it's fetched once, and only when a real region actually needs
 * drawing). Files are copies of static/vendor/geo/* served from /geo/ (the
 * Vite public dir). The geometry→Leaflet-rings conversion is pure and tested.
 */

export interface GeoGeometry {
  type: string;
  coordinates: unknown;
}

export interface GeoFeature {
  type: string;
  id?: string | number;
  properties?: { name?: string; [key: string]: unknown };
  geometry: GeoGeometry;
}

export interface GeoIndex {
  byFips: Record<string, GeoFeature>;
  byState: Record<string, GeoFeature>;
}

let geoCache: GeoIndex | null = null;
let geoPromise: Promise<GeoIndex> | null = null;

/** The loaded index, or null if loadGeo() hasn't resolved yet. */
export function getGeo(): GeoIndex | null {
  return geoCache;
}

export function loadGeo(): Promise<GeoIndex> {
  if (geoCache) return Promise.resolve(geoCache);
  if (geoPromise) return geoPromise;
  geoPromise = Promise.all([
    fetch('/geo/us-counties.geojson').then((r) => r.json()),
    fetch('/geo/us-states.geojson').then((r) => r.json()),
  ])
    .then(([counties, states]: [{ features: GeoFeature[] }, { features: GeoFeature[] }]) => {
      const byFips: Record<string, GeoFeature> = {};
      counties.features.forEach((f) => {
        if (f.id !== undefined) byFips[String(f.id)] = f;
      });
      const byState: Record<string, GeoFeature> = {};
      states.features.forEach((f) => {
        byState[(f.properties?.name || '').toLowerCase()] = f;
      });
      geoCache = { byFips, byState };
      return geoCache;
    })
    .catch((e) => {
      geoPromise = null;
      throw e;
    });
  return geoPromise;
}

/** GeoJSON features for a shape-region source/draft (or [] if geo isn't
 * loaded yet / nothing matched). `s` only needs {area_kind, counties,
 * region_name}. */
export function featuresFor(
  s: { area_kind?: string; counties?: string[]; region_name?: string },
  geo: GeoIndex | null,
): GeoFeature[] {
  if (!geo) return [];
  if (s.area_kind === 'counties') {
    return [...new Set(s.counties || [])].map((f) => geo.byFips[f]).filter(Boolean);
  }
  if (s.area_kind === 'state' && s.region_name) {
    const f = geo.byState[s.region_name.toLowerCase()];
    return f ? [f] : [];
  }
  return [];
}

export type LatLng = [number, number];

/**
 * Convert a GeoJSON Polygon/MultiPolygon into Leaflet [lat,lng] ring arrays
 * for L.polygon. Regions are drawn with L.polygon directly instead of
 * L.geoJSON — the GeoJSON layer was throwing in-browser (old frontend) and
 * taking the whole map down with it. Returns null for anything unexpected
 * (caller falls back to a dot).
 */
export function geometryToLatLngs(
  geom: GeoGeometry | null | undefined,
): LatLng[][] | LatLng[][][] | null {
  if (!geom) return null;
  const ring = (r: number[][]): LatLng[] => r.map((p) => [p[1], p[0]]); // GeoJSON [lng,lat] -> Leaflet [lat,lng]
  if (geom.type === 'Polygon') return (geom.coordinates as number[][][]).map(ring); // [outer, hole, …]
  if (geom.type === 'MultiPolygon') {
    return (geom.coordinates as number[][][][]).map((poly) => poly.map(ring));
  }
  return null;
}
