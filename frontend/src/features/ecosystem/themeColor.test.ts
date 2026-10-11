import { describe, expect, it } from 'vitest';
import { isDarkColor, parseColor, tileLayersFor } from './themeColor';

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

describe('tileLayersFor — which basemap to draw', () => {
  it('uses CARTO, with the key in the URL, when a key is set', () => {
    const layers = tileLayersFor('light', 'abc 123');
    expect(layers).toHaveLength(1);
    expect(layers[0].url).toContain('basemaps.cartocdn.com/rastertiles/light_all/');
    expect(layers[0].url).toContain('?key=abc%20123');
    expect(tileLayersFor('dark', 'k')[0].url).toContain('/dark_all/');
  });

  it('falls back to Esri gray canvas plus labels when there is no key', () => {
    for (const key of [undefined, '', '   ']) {
      const layers = tileLayersFor('light', key);
      expect(layers).toHaveLength(2);
      expect(layers[0].url).toContain('World_Light_Gray_Base');
      expect(layers[1].url).toContain('World_Light_Gray_Reference');
      expect(layers[0].url).not.toContain('key=');
    }
    expect(tileLayersFor('dark', undefined)[0].url).toContain('World_Dark_Gray_Base');
  });

  it('never asks Esri for a zoom it does not serve', () => {
    for (const l of tileLayersFor('light', undefined)) expect(l.maxNativeZoom).toBe(16);
  });
});
