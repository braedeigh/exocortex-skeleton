/**
 * blend.ts — color interpolation, ported verbatim from static/js/sky-theme.js.
 * bg/cardBg/text/border blend as hex; textSecondary/textMuted blend as rgba
 * strings (alpha interpolates too). Pure — the highest-value test target.
 */
import type { PhaseColors } from './palettes';

export function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function lerpColor(a: string, b: string, t: number): string {
  const ar = hexToRgb(a);
  const br = hexToRgb(b);
  return rgbToHex(
    ar[0] + (br[0] - ar[0]) * t,
    ar[1] + (br[1] - ar[1]) * t,
    ar[2] + (br[2] - ar[2]) * t,
  );
}

export function lerpRgba(a: string, b: string, t: number): string {
  // Parse rgba strings
  function parse(s: string): number[] {
    const m = s.match(/[\d.]+/g);
    return m ? m.map(Number) : [0, 0, 0, 0];
  }
  const ap = parse(a);
  const bp = parse(b);
  const r = ap[0] + (bp[0] - ap[0]) * t;
  const g = ap[1] + (bp[1] - ap[1]) * t;
  const bl = ap[2] + (bp[2] - ap[2]) * t;
  const al = ap[3] + (bp[3] - ap[3]) * t;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bl)},${al.toFixed(2)})`;
}

export function blendThemes(a: PhaseColors, b: PhaseColors, t: number): PhaseColors {
  return {
    bg: lerpColor(a.bg, b.bg, t),
    cardBg: lerpColor(a.cardBg, b.cardBg, t),
    text: lerpColor(a.text, b.text, t),
    textSecondary: lerpRgba(a.textSecondary, b.textSecondary, t),
    textMuted: lerpRgba(a.textMuted, b.textMuted, t),
    border: lerpColor(a.border, b.border, t),
  };
}
