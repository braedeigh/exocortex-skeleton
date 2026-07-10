/**
 * resolve.ts — pure core of the theming engine: merge saved overrides over
 * the defaults (resolveSkyConfig), decide the active mode
 * (currentThemeMode), and compute the palette a given mode shows at a given
 * time (computeModeTheme / computeRunwayTheme). Ported from
 * static/js/sky-theme.js resolveSkyConfig() + updateSkyTheme(); the DOM side
 * (inline-style application, timers, postMessage) lives in engine.ts.
 */
import { blendThemes } from './blend';
import {
  ACCENT_KEYS,
  OFFSET_KEYS,
  PHASE_ORDER,
  SKY_DEFAULT_ACCENTS,
  SKY_DEFAULT_OFFSETS,
  SKY_DEFAULT_THEMES,
  type Accents,
  type OffsetKey,
  type PhaseColors,
  type PhaseName,
  type ThemeMode,
  type ThemeOverrides,
} from './palettes';
import { sunTimesFromDay } from './solar';

export interface SkyConfig {
  themes: Record<PhaseName, PhaseColors>;
  offsets: Record<OffsetKey, number>;
  accents: Accents;
  /** The master "Enable sky theme" toggle (only consulted in 'sky' mode). */
  enabled: boolean;
}

// Resolve overrides → working config
export function resolveSkyConfig(overrides: ThemeOverrides = {}): SkyConfig {
  const themes = {} as Record<PhaseName, PhaseColors>;
  for (const key of PHASE_ORDER) {
    themes[key] = { ...SKY_DEFAULT_THEMES[key], ...((overrides.themes ?? {})[key] ?? {}) };
  }
  // Per-phase disable: a disabled phase inherits the next phase's colors so
  // its window is visually transparent. Order matches the day cycle.
  const enabled = overrides.phasesEnabled ?? {};
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const p = PHASE_ORDER[i];
    if (enabled[p] === false) {
      // Find next enabled phase (wrap around)
      for (let j = 1; j <= PHASE_ORDER.length; j++) {
        const next = PHASE_ORDER[(i + j) % PHASE_ORDER.length];
        if (enabled[next] !== false) {
          themes[p] = themes[next];
          break;
        }
      }
    }
  }
  const offsets = { ...SKY_DEFAULT_OFFSETS };
  for (const key of OFFSET_KEYS) {
    const v = overrides.offsets?.[key];
    if (v !== undefined) offsets[key] = v;
  }
  const accents = { ...SKY_DEFAULT_ACCENTS };
  for (const key of ACCENT_KEYS) {
    const v = overrides.accents?.[key];
    if (v !== undefined) accents[key] = v;
  }
  return { themes, offsets, accents, enabled: overrides.enabled !== false };
}

/**
 * Which theme mode is active: explicit override wins, then the mode the
 * browser remembered (localStorage 'themeMode' — passed in so this stays
 * pure), then 'off'/'sky' depending on the master toggle.
 */
export function currentThemeMode(
  overrides: ThemeOverrides = {},
  storedMode: string | null = null,
): ThemeMode {
  if (overrides.mode) return overrides.mode;
  if (storedMode) return storedMode as ThemeMode;
  return overrides.enabled === false ? 'off' : 'sky';
}

/**
 * The full time-of-day color runway ('sky' mode): pick/blend between the
 * seven phase palettes for the given decimal hour and day-of-year. Phase
 * boundaries are sunrise/sunset plus the configured offsets.
 */
export function computeRunwayTheme(
  cfg: SkyConfig,
  hour: number,
  dayOfYear: number,
): PhaseColors {
  const { sunrise, sunset } = sunTimesFromDay(dayOfYear);
  const themes = cfg.themes;

  // Phase boundaries (decimal hours) — offsets are relative to sunrise/sunset
  const o = cfg.offsets;
  const dawnStart = sunrise + o.dawnStart;
  const dawnEnd = sunrise + o.dawnEnd;
  const postDawnEnd = sunrise + o.postDawnEnd;
  const morningEnd = sunrise + o.morningEnd;
  const goldenStart = sunset + o.goldenStart;
  const twilightStart = sunset + o.twilightStart;
  const twilightEnd = sunset + o.twilightEnd;

  if (hour < dawnStart || hour >= twilightEnd) {
    // Night
    return themes.night;
  } else if (hour < dawnEnd) {
    // Night → dawn
    const t = (hour - dawnStart) / (dawnEnd - dawnStart);
    return blendThemes(themes.night, themes.dawn, t);
  } else if (hour < postDawnEnd) {
    // Dawn → postDawn (text flips dark fast)
    const t = (hour - dawnEnd) / (postDawnEnd - dawnEnd);
    return blendThemes(themes.dawn, themes.postDawn, t);
  } else if (hour < morningEnd) {
    // PostDawn → morning (bg lightens, text already dark)
    const t = (hour - postDawnEnd) / (morningEnd - postDawnEnd);
    return blendThemes(themes.postDawn, themes.morning, t);
  } else if (hour < goldenStart) {
    // Day
    return themes.day;
  } else if (hour < twilightStart) {
    // Golden hour: day → golden. Hold text-day-dark longer, snap to dark mode near the end
    // so we don't sit in a muddy mid-tone where text and bg both blend to similar luminance.
    const tRaw = (hour - goldenStart) / (twilightStart - goldenStart);
    const t = tRaw < 0.7 ? tRaw * 0.2 : 0.14 + ((tRaw - 0.7) / 0.3) * 0.86;
    return blendThemes(themes.day, themes.golden, t);
  } else {
    // Twilight: golden → night. Use a sharper curve so the mid-blend doesn't
    // hold a muddy gray-brown with low contrast for very long. Bg darkens
    // faster than text/border, so text gets the dark-mode flip near the end.
    const tRaw = (hour - twilightStart) / (twilightEnd - twilightStart);
    // Snap at 0.7 — under that, hold the warm-day appearance (just slightly dimmed bg)
    const t = tRaw < 0.7 ? tRaw * 0.25 : 0.175 + ((tRaw - 0.7) / 0.3) * 0.825;
    return blendThemes(themes.golden, themes.night, t);
  }
}

/**
 * The palette a mode shows at a moment in time, or null when the engine
 * should leave the static CSS-variable defaults alone ('off' mode, or 'sky'
 * mode with the master toggle off). Mirrors updateSkyTheme()'s mode branch.
 */
export function computeModeTheme(
  cfg: SkyConfig,
  mode: ThemeMode,
  hour: number,
  dayOfYear: number,
): PhaseColors | null {
  if (mode === 'off') return null; // leave CSS var defaults from the stylesheet
  if (mode === 'light') return cfg.themes.postDawn;
  if (mode === 'dark') return cfg.themes.twilight;
  if (mode === 'auto') {
    // Lavender (postDawn) between sunrise and sunset, indigo (twilight) otherwise.
    const { sunrise, sunset } = sunTimesFromDay(dayOfYear);
    const isDay = hour >= sunrise && hour < sunset;
    return isDay ? cfg.themes.postDawn : cfg.themes.twilight;
  }

  // mode === 'sky' — the full time-of-day color runway
  if (!cfg.enabled) return null; // Master toggle off — leave CSS var defaults
  return computeRunwayTheme(cfg, hour, dayOfYear);
}
