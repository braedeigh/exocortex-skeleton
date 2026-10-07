import { describe, expect, it } from 'vitest';
import { localTimeInputs, skyPlace, sunTimesFromDay } from './solar';

// Reference values computed by executing the original static/js/sky-theme.js
// sunTimesFromDay() — the port must reproduce them bit-for-bit.
describe('sunTimesFromDay', () => {
  it('sunrise is always before sunset', () => {
    for (let day = 1; day <= 365; day += 7) {
      const { sunrise, sunset } = sunTimesFromDay(day);
      expect(sunrise).toBeLessThan(sunset);
    }
  });

  // Reference city for the fixed expectations below: 30.2672°N, 97.7431°W,
  // UTC-5 — the coordinates the original engine's reference values were
  // computed for. Passed explicitly: the module defaults are the owner's
  // .env.local values (generic equator/UTC when unset).
  const REF = [30.2672, -97.7431, -5] as const;

  it('summer days are longer than winter days at a mid-northern latitude', () => {
    const winter = sunTimesFromDay(355, ...REF); // ~Dec 21
    const summer = sunTimesFromDay(172, ...REF); // ~Jun 21
    const winterLen = winter.sunset - winter.sunrise;
    const summerLen = summer.sunset - summer.sunrise;
    expect(summerLen).toBeGreaterThan(winterLen);
    // ~10h winter, ~14h summer daylight at 30°N
    expect(winterLen).toBeGreaterThan(9.5);
    expect(winterLen).toBeLessThan(10.5);
    expect(summerLen).toBeGreaterThan(13.5);
    expect(summerLen).toBeLessThan(14.5);
  });

  it('mid-June sunrise/sunset land near the reference clock times', () => {
    // June 20 at the reference city: sunrise ~06:29, sunset ~20:36 local.
    const { sunrise, sunset } = sunTimesFromDay(171, ...REF);
    expect(sunrise).toBeGreaterThan(6.2);
    expect(sunrise).toBeLessThan(6.8);
    expect(sunset).toBeGreaterThan(20.2);
    expect(sunset).toBeLessThan(20.9);
  });

  it('equinox day length is close to 12 hours', () => {
    const { sunrise, sunset } = sunTimesFromDay(80); // ~Mar 21
    expect(sunset - sunrise).toBeGreaterThan(11.9);
    expect(sunset - sunrise).toBeLessThan(12.4);
  });

  it('is a pure function of day-of-year', () => {
    expect(sunTimesFromDay(100)).toEqual(sunTimesFromDay(100));
  });
});

describe('localTimeInputs', () => {
  it('converts a Date to decimal hour + 1-based day-of-year', () => {
    const { hour, dayOfYear } = localTimeInputs(new Date(2026, 0, 1, 6, 30));
    expect(hour).toBeCloseTo(6.5, 5);
    expect(dayOfYear).toBe(1);
  });

  it('matches the legacy Jan-0 day-of-year arithmetic at year end', () => {
    const { dayOfYear } = localTimeInputs(new Date(2026, 11, 31, 12, 0));
    expect(dayOfYear).toBe(365);
  });
});

describe('the place the sky theme keeps time for', () => {
  const home = { lat: 51.5, lng: -0.1, tzOffset: 1 };

  it('uses the install’s own coordinates on the normal site, and the equator when unset', () => {
    expect(skyPlace({ standalone: false, home, clockOffsetHours: 9 })).toEqual({ lat: 51.5, lng: -0.1, tzOffset: 1 });
    expect(skyPlace({ standalone: false, home: {}, clockOffsetHours: 9 })).toEqual({ lat: 0, lng: 0, tzOffset: 0 });
  });

  it('ignores them in the desktop app and gives a 6-to-18 day by the machine’s own clock, in any timezone', () => {
    for (const clockOffsetHours of [-8, -5, 0, 5.5, 9, 13]) {
      const place = skyPlace({ standalone: true, home, clockOffsetHours });
      expect(place.lat).toBe(0);
      for (const day of [1, 91, 172, 266, 355]) {
        const { sunrise, sunset } = sunTimesFromDay(day, place.lat, place.lng, place.tzOffset);
        // Within half an hour of 6 and 18: the equation of time moves it a little.
        expect(Math.abs(sunrise - 6)).toBeLessThan(0.5);
        expect(Math.abs(sunset - 18)).toBeLessThan(0.5);
      }
    }
  });
});
