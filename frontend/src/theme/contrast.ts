/**
 * contrast.ts — the WCAG contrast maths behind the accessibility readout in
 * the Settings theme editor (features/settings/PhaseCard.tsx).
 *
 * Give it two colors and it says how far apart they read: a ratio from 1
 * (identical) to 21 (black on white), plus which accessibility standard that
 * ratio clears. The two things that make this more than a formula:
 *
 * - Alpha. Two of the six phase colors (textSecondary, textMuted) are stored
 *   as rgba strings with alpha < 1, and a half-transparent color's real
 *   contrast depends on what's behind it. So the foreground is composited
 *   onto the background first, then measured — which is what the eye
 *   actually sees.
 * - Color formats. Phase palettes mix '#rrggbb', shorthand '#fff' (day's
 *   cardBg) and 'rgba(...)', so all three parse here.
 *
 * Pure and dependency-free — the sibling of blend.ts, and tested the same way
 * (contrast.test.ts). Unparseable input returns null rather than a made-up
 * number, so the UI can show "—" instead of a confident lie.
 *
 * Prompt that produced it: "Contrast checker for color accessibility
 * standards".
 */

/** sRGB channels, 0–255, plus alpha 0–1. */
export type Rgba = [number, number, number, number];

/**
 * '#fff' | '#rrggbb' | 'rgb(r,g,b)' | 'rgba(r,g,b,a)' → channels, or null if
 * it's none of those (a CSS keyword, a var(), a typo mid-edit in the hex
 * field). Callers treat null as "can't say", not as black.
 */
export function parseColor(value: string): Rgba | null {
  const s = (value ?? '').trim();
  if (!s) return null;

  const short = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
      1,
    ];
  }

  const full = s.match(/^#([0-9a-f]{6})$/i);
  if (full) {
    return [
      parseInt(full[1].slice(0, 2), 16),
      parseInt(full[1].slice(2, 4), 16),
      parseInt(full[1].slice(4, 6), 16),
      1,
    ];
  }

  const fn = s.match(/^rgba?\(([^)]*)\)$/i);
  if (fn) {
    const parts = fn[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return [
      clampChannel(parts[0]),
      clampChannel(parts[1]),
      clampChannel(parts[2]),
      Math.min(1, Math.max(0, alpha)),
    ];
  }

  return null;
}

function clampChannel(n: number): number {
  return Math.min(255, Math.max(0, n));
}

/** Lay a translucent foreground over an opaque background — standard source-over
 * alpha compositing, per channel. The background is assumed opaque (every
 * surface color in a phase palette is). */
function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

/** WCAG relative luminance: linearize each sRGB channel, then weight them the
 * way the eye weights them (green dominates, blue barely registers). */
export function relativeLuminance(rgb: Rgba): number {
  const [r, g, b] = rgb.slice(0, 3).map((c) => {
    const n = c / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The contrast ratio between a foreground and a background, 1–21. The
 * foreground is flattened onto the background first, so an alpha-carrying
 * text color is measured as it actually appears. Null if either color didn't
 * parse.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const bg = parseColor(background);
  const fgRaw = parseColor(foreground);
  if (!bg || !fgRaw) return null;

  const fg = composite(fgRaw, bg);
  const lightest = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darkest = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lightest + 0.05) / (darkest + 0.05);
}

/** The best WCAG grade a ratio earns for body-size text. 'AA Large' means it
 * only clears the relaxed bar for large/bold text (3:1), so it's a pass for a
 * heading and a fail for a paragraph. */
export type ContrastLevel = 'AAA' | 'AA' | 'AA Large' | 'Fail';

export function wcagLevel(ratio: number | null): ContrastLevel | null {
  if (ratio === null) return null;
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

/**
 * The worse (lower) of several ratios. A text color sits on two surfaces —
 * the card and the page behind it — and the grade shown has to be the one it
 * earns on the surface where it reads worst, or a green badge would hide a
 * real failure on the other one. Unknown (null) ratios are skipped; all
 * unknown → null.
 */
export function worstRatio(...ratios: Array<number | null>): number | null {
  const known = ratios.filter((r): r is number => r !== null);
  return known.length ? Math.min(...known) : null;
}

/** Display form: "12.63" — two decimals is the convention every contrast tool
 * uses, and the third decimal never changes a verdict. */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : ratio.toFixed(2);
}
