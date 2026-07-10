import { describe, expect, it } from 'vitest';
import { blendThemes, hexToRgb, lerpColor, lerpRgba, rgbToHex } from './blend';
import { SKY_DEFAULT_THEMES } from './palettes';

describe('hexToRgb / rgbToHex', () => {
  it('round-trips a hex color', () => {
    expect(rgbToHex(...hexToRgb('#1a2b3c'))).toBe('#1a2b3c');
  });

  it('rgbToHex clamps out-of-range channels', () => {
    expect(rgbToHex(-10, 300, 128)).toBe('#00ff80');
  });

  it('rgbToHex rounds fractional channels', () => {
    expect(rgbToHex(15.6, 15.4, 0)).toBe('#100f00');
  });
});

describe('lerpColor', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerpColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('interpolates midway per channel', () => {
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(lerpColor('#0d0d1a', '#1a1520', 0.5)).toBe('#14111d');
  });
});

describe('lerpRgba', () => {
  it('interpolates channels and alpha, alpha to 2 decimals', () => {
    expect(lerpRgba('rgba(220,210,195,0.75)', 'rgba(240,220,210,0.85)', 0.5)).toBe(
      'rgba(230,215,203,0.80)',
    );
  });

  it('returns exact endpoints (alpha formatted)', () => {
    expect(lerpRgba('rgba(10,20,30,0.5)', 'rgba(90,80,70,1)', 0)).toBe('rgba(10,20,30,0.50)');
    expect(lerpRgba('rgba(10,20,30,0.5)', 'rgba(90,80,70,1)', 1)).toBe('rgba(90,80,70,1.00)');
  });

  it('treats an unparsable string as transparent black (legacy behavior)', () => {
    expect(lerpRgba('nope', 'nope', 0.5)).toBe('rgba(0,0,0,0.00)');
  });
});

describe('blendThemes', () => {
  it('blends hex keys as hex and rgba keys as rgba', () => {
    const mid = blendThemes(SKY_DEFAULT_THEMES.night, SKY_DEFAULT_THEMES.dawn, 0.5);
    expect(mid.bg).toBe('#14111d');
    expect(mid.cardBg).toMatch(/^#[0-9a-f]{6}$/);
    expect(mid.text).toMatch(/^#[0-9a-f]{6}$/);
    expect(mid.border).toMatch(/^#[0-9a-f]{6}$/);
    expect(mid.textSecondary).toBe('rgba(230,215,203,0.80)');
    expect(mid.textMuted).toMatch(/^rgba\(\d+,\d+,\d+,\d+\.\d{2}\)$/);
  });

  it('t=0 reproduces theme a exactly for hex channels', () => {
    const same = blendThemes(SKY_DEFAULT_THEMES.day, SKY_DEFAULT_THEMES.golden, 0);
    expect(same.bg).toBe(SKY_DEFAULT_THEMES.day.bg);
    // legacy quirk preserved: '#fff' shorthand expands oddly through the
    // 2-char slicing, so cardBg is only guaranteed stable for 6-digit hex
    expect(same.text).toBe(SKY_DEFAULT_THEMES.day.text);
  });
});
