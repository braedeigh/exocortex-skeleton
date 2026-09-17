/**
 * homeCluster.ts — which sources count as "near home"?
 *
 * The food map opens centered over the owner's home country, not the whole
 * world: a single far source (one import from another continent) would
 * otherwise zoom the map out until everything near home is a speck. There
 * is no country field on a source, so "home country" is a distance: every
 * source within HOME_RADIUS_KM of the configured home (ownerHome.ts). From
 * a home in the central US, 3500 km reaches both coasts and neither South
 * America nor Europe. With no home configured, or nothing near it, the
 * cluster is everything — the map falls back to framing it all.
 *
 * Prompt that produced it: "make it center over the US stuff actually".
 */
import type { EcoSource } from './types';

export const HOME_RADIUS_KM = 3500;

/** Great-circle distance in km (haversine). */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** The sources to frame on open: those within `radiusKm` of home, or all of
 * `sources` when home is unset or none are within reach. Sources without
 * coordinates are dropped either way. */
export function homeCluster(
  sources: EcoSource[],
  home: [number, number] | null,
  radiusKm: number = HOME_RADIUS_KM,
): EcoSource[] {
  const placed = sources.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  if (!home) return placed;
  const near = placed.filter((s) => distanceKm(home[0], home[1], s.lat as number, s.lng as number) <= radiusKm);
  return near.length ? near : placed;
}
