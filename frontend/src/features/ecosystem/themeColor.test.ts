import { describe, expect, it } from 'vitest';
import { isDarkColor, parseColor } from './themeColor';

describe('parseColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseColor('#f5f0e8')).toEqual([245, 240, 232]);
  });
  it('parses 3-digit hex', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#123')).toEqual([17, 34, 51]);
  });
  it('parses rgb()/rgba()', () => {
    expect(parseColor('rgb(26, 26, 46)')).toEqual([26, 26, 46]);
    expect(parseColor('rgba(26, 26, 46, 0.5)')).toEqual([26, 26, 46]);
  });
  it('returns null for junk', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor(null)).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('salmon')).toBeNull();
  });
});

describe('isDarkColor', () => {
  it('the light lavender day palette is light', () => {
    expect(isDarkColor('#f5f0e8')).toBe(false);
  });
  it('the twilight indigo palette is dark', () => {
    expect(isDarkColor('#1a1a2e')).toBe(true);
    expect(isDarkColor('rgb(26, 26, 46)')).toBe(true);
  });
  it('unparseable backgrounds fall back to light', () => {
    expect(isDarkColor('')).toBe(false);
    expect(isDarkColor('var(--oops)')).toBe(false);
  });
  it('tolerates surrounding whitespace (getPropertyValue output)', () => {
    expect(isDarkColor(' #1a1a2e ')).toBe(true);
  });
});
