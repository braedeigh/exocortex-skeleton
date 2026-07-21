/**
 * The owner's home coordinates + timezone — PERSONAL values that never live
 * hardcoded in the shareable skeleton. Set them per-install in
 * frontend/.env.local (gitignored, read by Vite at build time):
 *
 *   VITE_HOME_LAT=30.27
 *   VITE_HOME_LNG=-97.74
 *   VITE_HOME_TZ_OFFSET=-5
 *
 * Unset, everything still works generically: the sky theme falls back to
 * equatorial ~12h days, and the ecosystem map opens on a world view.
 */
const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const HOME_LAT = num(import.meta.env.VITE_HOME_LAT);
export const HOME_LNG = num(import.meta.env.VITE_HOME_LNG);
export const HOME_TZ_OFFSET = num(import.meta.env.VITE_HOME_TZ_OFFSET);
