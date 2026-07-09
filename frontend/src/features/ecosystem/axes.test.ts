import { describe, expect, it } from 'vitest';
import {
  ECO_TX,
  ECO_TX_ORDER,
  compareSources,
  geoSourceInfo,
  geoSourceOf,
  isShapeSource,
  metaLabel,
  txInfo,
  txOf,
} from './axes';
import type { EcoSource } from './types';

describe('transparency axis', () => {
  it('normalizes unknown/missing values to unrated', () => {
    expect(txOf({ transparency: 'disclosed' })).toBe('disclosed');
    expect(txOf({ transparency: 'garbage' })).toBe('unrated');
    expect(txOf({})).toBe('unrated');
    expect(txOf(null)).toBe('unrated');
  });
  it('maps each level to its color', () => {
    expect(txInfo({ transparency: 'partial' }).color).toBe(ECO_TX.partial.color);
    expect(txInfo({ transparency: 'nope' })).toBe(ECO_TX.unrated);
  });
  it('orders most → least Proper', () => {
    expect(ECO_TX_ORDER).toEqual(['disclosed', 'partial', 'opaque', 'unrated']);
  });
});

describe('geo_source axis', () => {
  it('normalizes unknown values to unrated', () => {
    expect(geoSourceOf({ geo_source: 'proxy' })).toBe('proxy');
    expect(geoSourceOf({ geo_source: 'whatever' })).toBe('unrated');
    expect(geoSourceInfo({ geo_source: 'placed' }).icon).toBe('📍');
  });
});

describe('isShapeSource', () => {
  it('is true only for area sources with county/state outlines', () => {
    expect(isShapeSource({ precision: 'area', area_kind: 'counties' })).toBe(true);
    expect(isShapeSource({ precision: 'area', area_kind: 'state' })).toBe(true);
    expect(isShapeSource({ precision: 'area', area_kind: 'circle' })).toBe(false);
    expect(isShapeSource({ precision: 'point', area_kind: 'counties' })).toBe(false);
    expect(isShapeSource(null)).toBe(false);
  });
});

describe('metaLabel', () => {
  const base: EcoSource = { id: 'x', name: 'X' };
  it('counts unique counties', () => {
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'counties', counties: ['48453', '48453', '48021'] })).toBe(
      '2 counties (USDA)',
    );
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'counties', counties: ['48453'] })).toBe(
      '1 county (USDA)',
    );
  });
  it('labels state outlines', () => {
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'state', region_name: 'Texas' })).toBe('Texas (state)');
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'state' })).toBe('state (state)');
  });
  it('labels circle regions by radius', () => {
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'circle', radius_km: 199.6 })).toBe('~200 km region');
  });
  it('everything else is an exact spot', () => {
    expect(metaLabel(base)).toBe('exact spot');
    expect(metaLabel({ ...base, precision: 'area', area_kind: 'circle', radius_km: 0 })).toBe('exact spot');
  });
});

describe('compareSources', () => {
  it('sorts by transparency rank, then name', () => {
    const a: EcoSource = { id: 'a', name: 'Zucchini', transparency: 'disclosed' };
    const b: EcoSource = { id: 'b', name: 'Apples', transparency: 'opaque' };
    const c: EcoSource = { id: 'c', name: 'Beef', transparency: 'opaque' };
    expect([c, b, a].sort(compareSources).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
