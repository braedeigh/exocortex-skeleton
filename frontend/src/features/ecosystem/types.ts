/**
 * types.ts — shapes for the Ecosystem tab (food-source map).
 *
 * Mirrors routes/ecosystem.py's source record and the /api/data/ecosystem
 * payload (server.py get_data_ecosystem). A source is a grocery/meal-prep
 * item placed on a real map; three honest axes describe it:
 *   transparency — how disclosed the supply chain is (the "Proper" axis)
 *   precision    — how exact the area is (crisp dot vs soft region)
 *   geo_source   — how the DOT itself got placed (claim vs proxy vs guess)
 */

export type Transparency = 'disclosed' | 'partial' | 'opaque' | 'unrated';
export type GeoSourceKind = 'placed' | 'proxy' | 'guess' | 'unrated';
export type Precision = 'point' | 'area';
export type AreaKind = 'circle' | 'counties' | 'state';

export interface EcoSource {
  id: string;
  layer?: string;
  name: string;
  note?: string;
  lat?: number | null;
  lng?: number | null;
  precision?: Precision | string;
  radius_km?: number;
  /** May hold anything historically — normalize through txOf()/txInfo(). */
  transparency?: string;
  area_kind?: AreaKind | string;
  /** 5-digit county FIPS codes (area_kind === 'counties'). */
  counties?: string[];
  /** US state name (area_kind === 'state'). */
  region_name?: string;
  geo_source?: GeoSourceKind | string;
}

export interface EcoIngredient {
  item?: string;
  category?: string;
  [key: string]: unknown;
}

/** Light recipe (no instructions) from the eco_recipes stream. */
export interface EcoRecipe {
  id: string;
  name: string;
  ingredients?: EcoIngredient[];
}

/** GET /api/data/ecosystem — only the keys this tab reads. */
export interface EcosystemData {
  ecosystem?: { sources?: EcoSource[] };
  eco_recipes?: EcoRecipe[];
  usda_key_set?: boolean;
  server_date?: string;
  [key: string]: unknown;
}

/** The source being added/edited (the draft pin). `id` present = editing. */
export interface EcoDraft {
  id?: string;
  name: string;
  note: string;
  precision: Precision;
  radius_km: number;
  lat: number | null;
  lng: number | null;
  transparency: Transparency;
  area_kind: AreaKind;
  counties: string[];
  region_name: string;
  geo_source: GeoSourceKind;
}

export function newDraft(): EcoDraft {
  return {
    name: '',
    note: '',
    precision: 'point',
    radius_km: 0,
    lat: null,
    lng: null,
    transparency: 'unrated',
    area_kind: 'circle',
    counties: [],
    region_name: '',
    geo_source: 'unrated',
  };
}

export function draftFromSource(s: EcoSource): EcoDraft {
  return {
    id: s.id,
    name: s.name,
    note: s.note || '',
    precision: s.precision === 'area' ? 'area' : 'point',
    radius_km: s.radius_km || 0,
    lat: typeof s.lat === 'number' ? s.lat : null,
    lng: typeof s.lng === 'number' ? s.lng : null,
    transparency: (['disclosed', 'partial', 'opaque', 'unrated'].includes(s.transparency || '')
      ? s.transparency
      : 'unrated') as Transparency,
    area_kind: (['circle', 'counties', 'state'].includes(s.area_kind || '')
      ? s.area_kind
      : 'circle') as AreaKind,
    counties: (s.counties || []).slice(),
    region_name: s.region_name || '',
    geo_source: (['placed', 'proxy', 'guess', 'unrated'].includes(s.geo_source || '')
      ? s.geo_source
      : 'unrated') as GeoSourceKind,
  };
}
