import { describe, expect, it } from 'vitest';
import { contrastRatio, formatRatio, parseColor, wcagLevel, worstRatio } from './contrast';
import { SKY_DEFAULT_THEMES } from './palettes';

describe('parseColor', () => {
  it('reads the three formats the phase palettes actually use', () => {
    expect(parseColor('#1a2b3c')).toEqual([26, 43, 60, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('rgba(220,210,195,0.75)')).toEqual([220, 210, 195, 0.75]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1]);
  });

  it('returns null rather than guessing at anything else', () => {
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('var(--text)')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('hits the two ends of the scale', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#345678', '#345678')).toBeCloseTo(1, 5);
  });

  it('matches the published ratio for the classic AA boundary grey', () => {
    // #767676 on white is the greyest text that still clears AA (4.5:1).
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('is symmetric — which color is "foreground" only matters for alpha', () => {
    expect(contrastRatio('#1a1815', '#eeeae4')).toBeCloseTo(
      contrastRatio('#eeeae4', '#1a1815')!,
      10,
    );
  });

  it('composites a translucent foreground instead of reading it as opaque', () => {
    // Half-alpha black over white is really mid-grey: ~3.98, not black's 21.
    expect(contrastRatio('rgba(0,0,0,0.5)', '#ffffff')).toBeCloseTo(3.977, 2);
  });

  it('measures the same alpha differently on a light and a dark surface', () => {
    const onLight = contrastRatio('rgba(128,128,128,0.5)', '#ffffff')!;
    const onDark = contrastRatio('rgba(128,128,128,0.5)', '#000000')!;
    expect(onLight).not.toBeCloseTo(onDark, 2);
  });

  it('is null when a color cannot be parsed', () => {
    expect(contrastRatio('nope', '#ffffff')).toBeNull();
    expect(contrastRatio('#ffffff', 'nope')).toBeNull();
  });

  it('handles a real phase palette, shorthand hex and rgba alike', () => {
    const day = SKY_DEFAULT_THEMES.day;
    expect(contrastRatio(day.text, day.cardBg)).toBeGreaterThan(7);
    expect(contrastRatio(day.textMuted, day.cardBg)).toBeGreaterThan(1);
  });
});

describe('wcagLevel', () => {
  it('grades on the WCAG thresholds for body text', () => {
    expect(wcagLevel(21)).toBe('AAA');
    expect(wcagLevel(7)).toBe('AAA');
    expect(wcagLevel(6.99)).toBe('AA');
    expect(wcagLevel(4.5)).toBe('AA');
    expect(wcagLevel(4.49)).toBe('AA Large');
    expect(wcagLevel(3)).toBe('AA Large');
    expect(wcagLevel(2.99)).toBe('Fail');
    expect(wcagLevel(1)).toBe('Fail');
  });

  it('passes null through', () => {
    expect(wcagLevel(null)).toBeNull();
  });
});

describe('worstRatio', () => {
  it('grades on the surface where the color reads worst', () => {
    expect(worstRatio(8.2, 4.1)).toBe(4.1);
    expect(wcagLevel(worstRatio(8.2, 4.1))).toBe('AA Large');
  });

  it('skips unknown ratios, and is null only when nothing is known', () => {
    expect(worstRatio(null, 5.5)).toBe(5.5);
    expect(worstRatio(null, null)).toBeNull();
  });
});

describe('formatRatio', () => {
  it('shows two decimals, and an em dash for unknown', () => {
    expect(formatRatio(4.5427)).toBe('4.54');
    expect(formatRatio(21)).toBe('21.00');
    expect(formatRatio(null)).toBe('—');
  });
});
