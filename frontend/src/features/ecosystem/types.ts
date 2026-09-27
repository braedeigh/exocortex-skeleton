/**
 * types.ts — shapes for the Ecosystem tab (food-source map).
 *
 * Mirrors sourcestore.py's source (a row in SQL beside the foods) and the
 * /api/data/ecosystem payload (server.py get_data_ecosystem). A source is a
 * place a food comes from; four honest things describe it:
 *   transparency — how disclosed the supply chain is (the "Proper" axis)
 *   precision    — how exact the area is (crisp dot vs soft region)
 *   geo_source   — how the DOT itself got placed (claim vs proxy vs guess)
 *   origin       — where that placement information came from, and when
 * Foods reach a source through its `links` (food_links in SQL): a link names
 * a food, or one product of a food.
 */

export type Transparency = 'disclosed' | 'partial' | 'opaque' | 'unrated';
export type GeoSourceKind = 'placed' | 'proxy' | 'guess' | 'unrated';
export type Precision = 'point' | 'area';
export type AreaKind = 'circle' | 'counties' | 'state';
export type OriginKind = 'usda-nass' | 'geocoded' | 'package' | 'visit' | 'research' | 'hand' | 'unknown';

/** What USDA reported for one county of a source's outline. */
export interface CountyDetail {
  fips: string;
  county?: string;
  state?: string;
  value?: number | null;
  unit?: string;
}

/** One food↔source link. A product link names its food too; the public map
 * gets `via_product` instead of the product's name. */
export interface EcoLink {
  id: number;
  food_id?: number | null;
  food_name?: string | null;
  product_id?: number;
  product_name?: string;
  product_store?: string | null;
  via_product?: boolean;
}

/** A food from the catalog, with the sources it's traced to (the Foods panel). */
export interface EcoFood {
  id: number;
  name: string;
  category?: string | null;
  products: { id: number; name: string; store?: string | null; organic?: number | null }[];
  source_ids: string[];
}

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
  /** Where the placement information came from (sourcestore.ORIGINS). */
  origin?: OriginKind | string;
  origin_detail?: string;
  origin_url?: string;
  origin_date?: string;
  /** What USDA reported for each county, in its ranking order. */
  county_detail?: CountyDetail[];
  links?: EcoLink[];
  created_at?: string;
  updated_at?: string;
}

export interface EcoIngredient {
  item?: string;
  category?: string;
  /** The catalog food this line resolves to (by any name it goes by), or null. */
  food_id?: number | null;
  food_name?: string | null;
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
  eco_foods?: EcoFood[];
  /** origin word → what it means */
  eco_origins?: Record<string, string>;
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
  origin: OriginKind;
  origin_detail: string;
  origin_url: string;
  origin_date: string;
  county_detail: CountyDetail[];
  /** Adding only: the food (or product) this new source is for, linked on save. */
  food?: number | null;
  product_id?: number | null;
  /** What `food` is called, for the "will be linked to" line. */
  food_label?: string;
}

const ORIGIN_KINDS = ['usda-nass', 'geocoded', 'package', 'visit', 'research', 'hand', 'unknown'];

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
    origin: 'hand',
    origin_detail: '',
    origin_url: '',
    origin_date: '',
    county_detail: [],
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
    origin: (ORIGIN_KINDS.includes(s.origin || '') ? s.origin : 'unknown') as OriginKind,
    origin_detail: s.origin_detail || '',
    origin_url: s.origin_url || '',
    origin_date: s.origin_date || '',
    county_detail: (s.county_detail || []).slice(),
  };
}
