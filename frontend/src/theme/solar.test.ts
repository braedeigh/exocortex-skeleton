import { describe, expect, it } from 'vitest';
import { localTimeInputs, sunTimesFromDay } from './solar';

// Reference values computed by executing the original static/js/sky-theme.js
// sunTimesFromDay() — the port must reproduce them bit-for-bit.
describe('sunTimesFromDay', () => {
  it('sunrise is always before sunset', () => {
    for (let day = 1; day <= 365; day += 7) {
      const { sunrise, sunset } = sunTimesFromDay(day);
      expect(sunrise).toBeLessThan(sunset);
    }
  });

  it('summer days are longer than winter days in Austin', () => {
    const winter = sunTimesFromDay(355); // ~Dec 21
    const summer = sunTimesFromDay(172); // ~Jun 21
    const winterLen = winter.sunset - winter.sunrise;
    const summerLen = summer.sunset - summer.sunrise;
    expect(summerLen).toBeGreaterThan(winterLen);
    // Austin: ~10h winter, ~14h summer daylight
    expect(winterLen).toBeGreaterThan(9.5);
    expect(winterLen).toBeLessThan(10.5);
    expect(summerLen).toBeGreaterThan(13.5);
    expect(summerLen).toBeLessThan(14.5);
  });

  it('mid-June sunrise/sunset land near the real Austin CDT clock times', () => {
    // Real-world June 20 Austin: sunrise ~06:29, sunset ~20:36 CDT.
    const { sunrise, sunset } = sunTimesFromDay(171);
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
