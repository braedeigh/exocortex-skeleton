import { describe, expect, it } from 'vitest';
import { featuresFor, geometryToLatLngs } from './geo';
import type { GeoFeature, GeoIndex } from './geo';

function feat(id: string, name?: string): GeoFeature {
  return {
    type: 'Feature',
    id,
    properties: name ? { name } : {},
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] },
  };
}

const travis = feat('48453');
const williamson = feat('48491');
const texas = feat('tx', 'Texas');

const geo: GeoIndex = {
  byFips: { '48453': travis, '48491': williamson },
  byState: { texas: texas },
};

describe('geometryToLatLngs', () => {
  it('flips Polygon [lng,lat] coordinates to Leaflet [lat,lng] rings', () => {
    expect(
      geometryToLatLngs({ type: 'Polygon', coordinates: [[[-97.7, 30.2], [-97.6, 30.3]]] }),
    ).toEqual([[[30.2, -97.7], [30.3, -97.6]]]);
  });
  it('handles MultiPolygon nesting', () => {
    expect(
      geometryToLatLngs({
        type: 'MultiPolygon',
        coordinates: [[[[-97.7, 30.2]]], [[[-96.0, 29.0]]]],
      }),
    ).toEqual([[[[30.2, -97.7]]], [[[29.0, -96.0]]]]);
  });
  it('returns null for anything unexpected (caller falls back to a dot)', () => {
    expect(geometryToLatLngs({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    expect(geometryToLatLngs(null)).toBeNull();
  });
});

describe('featuresFor', () => {
  it('returns [] when geo has not loaded yet', () => {
    expect(featuresFor({ area_kind: 'counties', counties: ['48453'] }, null)).toEqual([]);
  });
  it('maps county FIPS to features, deduplicating and skipping unknowns', () => {
    expect(
      featuresFor({ area_kind: 'counties', counties: ['48453', '48453', '99999', '48491'] }, geo),
    ).toEqual([travis, williamson]);
  });
  it('resolves state names case-insensitively', () => {
    expect(featuresFor({ area_kind: 'state', region_name: 'TEXAS' }, geo)).toEqual([texas]);
    expect(featuresFor({ area_kind: 'state', region_name: 'Atlantis' }, geo)).toEqual([]);
    expect(featuresFor({ area_kind: 'state', region_name: '' }, geo)).toEqual([]);
  });
  it('returns [] for circle regions (no outline to draw)', () => {
    expect(featuresFor({ area_kind: 'circle' }, geo)).toEqual([]);
  });
});
