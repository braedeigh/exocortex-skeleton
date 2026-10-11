/**
 * solar.ts — the owner's-city sunrise/sunset from day-of-year. Pure math,
 * ported line-for-line from static/js/sky-theme.js sunTimesFromDay(): solar
 * declination from a cosine fit, hour angle at -0.833° (refraction-corrected
 * horizon), equation of time, solar noon shifted into the local timezone.
 */
import { HOME_LAT, HOME_LNG, HOME_TZ_OFFSET } from '../ownerHome';
import { isStandalone } from '../shell/standalone';

/** A spot on the earth and its clock, which is all the sun maths needs. */
export interface SkyPlace {
  lat: number;
  lng: number;
  tzOffset: number;
}

/**
 * Pick the place the sky theme keeps time for.
 *
 * The normal site uses the owner's coordinates and timezone from .env.local
 * (see ownerHome.ts); unset, the equatorial/UTC defaults give a sane ~12h day
 * year-round.
 *
 * The desktop app runs on someone else's machine, somewhere unknown, so it
 * ignores those and reads the machine's own clock instead: the equator, at
 * the middle of this computer's timezone. That gives sunrise near 6 and
 * sunset near 18 by the local clock everywhere. It is a rough day, not the
 * real sun, because the app doesn't know where the person is.
 */
export function skyPlace(args: {
  standalone: boolean;
  home: { lat?: number; lng?: number; tzOffset?: number };
  /** Hours this computer's clock is ahead of UTC. */
  clockOffsetHours: number;
}): SkyPlace {
  if (args.standalone) {
    return { lat: 0, lng: args.clockOffsetHours * 15, tzOffset: args.clockOffsetHours };
  }
  return { lat: args.home.lat ?? 0, lng: args.home.lng ?? 0, tzOffset: args.home.tzOffset ?? 0 };
}

const PLACE = skyPlace({
  standalone: isStandalone(),
  home: { lat: HOME_LAT, lng: HOME_LNG, tzOffset: HOME_TZ_OFFSET },
  clockOffsetHours: -new Date().getTimezoneOffset() / 60,
});

export const SKY_LAT = PLACE.lat;
export const SKY_LNG = PLACE.lng;
export const SKY_TZ_OFFSET = PLACE.tzOffset;

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
