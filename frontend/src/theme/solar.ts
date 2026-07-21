/**
 * solar.ts — the owner's-city sunrise/sunset from day-of-year. Pure math,
 * ported line-for-line from static/js/sky-theme.js sunTimesFromDay(): solar
 * declination from a cosine fit, hour angle at -0.833° (refraction-corrected
 * horizon), equation of time, solar noon shifted into the local timezone.
 */
import { HOME_LAT, HOME_LNG, HOME_TZ_OFFSET } from '../ownerHome';

// The owner's coordinates + tz come from .env.local (see ownerHome.ts).
// Unset, the equatorial/UTC defaults give a sane ~12h day year-round.
export const SKY_LAT = HOME_LAT ?? 0;
export const SKY_LNG = HOME_LNG ?? 0;
export const SKY_TZ_OFFSET = HOME_TZ_OFFSET ?? 0;

export interface SunTimes {
  /** Decimal local hours, e.g. 6.5 = 06:30. */
  sunrise: number;
  sunset: number;
}

export function sunTimesFromDay(
  dayOfYear: number,
  lat: number = SKY_LAT,
  lng: number = SKY_LNG,
  tzOffset: number = SKY_TZ_OFFSET,
): SunTimes {
  const rad = Math.PI / 180;

  const declination = -23.44 * Math.cos((rad * 360 / 365) * (dayOfYear + 10));

  const cosHA =
    (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(declination * rad)) /
    (Math.cos(lat * rad) * Math.cos(declination * rad));
  if (cosHA > 1 || cosHA < -1) return { sunrise: 6, sunset: 18 };
  const halfDay = Math.acos(cosHA) / rad / 15;

  const B = (rad * 360 / 365) * (dayOfYear - 81);
  const EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  const solarNoonUTC = 12 - EoT / 60 - lng / 15;

  const solarNoonLocal = solarNoonUTC + tzOffset;

  return {
    sunrise: solarNoonLocal - halfDay,
    sunset: solarNoonLocal + halfDay,
  };
}

/** Day-of-year (1-based, matching `new Date() - Jan 0` in the legacy engine)
 * and decimal hour for "now" — the runtime inputs to the sky computation. */
export function localTimeInputs(now: Date = new Date()): { hour: number; dayOfYear: number } {
  const hour = now.getHours() + now.getMinutes() / 60;
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000,
  );
  return { hour, dayOfYear };
}
