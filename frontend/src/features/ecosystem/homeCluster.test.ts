import { describe, expect, it } from 'vitest';
import { distanceKm, homeCluster } from './homeCluster';
import type { EcoSource } from './types';

const src = (id: string, lat: number | null, lng: number | null): EcoSource => ({ id, name: id, lat, lng });
const austin: [number, number] = [30.27, -97.74];
const seattle = src('seattle', 47.6, -122.3);
const maine = src('maine', 44.3, -69.8);
const bolivia = src('bolivia', -16.5, -68.1);
const unplaced = src('unplaced', null, null);

describe('home cluster', () => {
  it('measures great-circle distance', () => {
    expect(Math.round(distanceKm(austin[0], austin[1], seattle.lat!, seattle.lng!))).toBeGreaterThan(2700);
    expect(Math.round(distanceKm(austin[0], austin[1], seattle.lat!, seattle.lng!))).toBeLessThan(2900);
  });
  it('keeps both coasts and drops another continent', () => {
    expect(homeCluster([seattle, maine, bolivia, unplaced], austin).map((s) => s.id)).toEqual(['seattle', 'maine']);
  });
  it('falls back to everything placed when nothing is near home', () => {
    expect(homeCluster([bolivia, unplaced], austin).map((s) => s.id)).toEqual(['bolivia']);
  });
  it('is everything placed when no home is configured', () => {
    expect(homeCluster([seattle, bolivia, unplaced], null).map((s) => s.id)).toEqual(['seattle', 'bolivia']);
  });
});
