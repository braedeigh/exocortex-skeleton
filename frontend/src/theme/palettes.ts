/**
 * palettes.ts — the sky-theme default palettes, phase timing offsets and
 * accent colors, ported verbatim from static/js/sky-theme.js (the values are
 * the contract: saved overrides in theme_settings.json merge over these, and
 * the Settings page shows these as the "default" state of every field).
 */

/** The seven day-phases, in day-cycle order (used for disabled-phase inheritance). */
export const PHASE_ORDER = [
  'night',
  'dawn',
  'postDawn',
  'morning',
  'day',
  'golden',
  'twilight',
] as const;

export type PhaseName = (typeof PHASE_ORDER)[number];

/** The six colors each phase carries — names match the CSS custom properties
 * they feed (--bg, --card-bg, --text, --text-secondary, --text-muted, --border). */
export interface PhaseColors {
  bg: string;
  cardBg: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
}

export type ColorKey = keyof PhaseColors;

/** Boundary offsets in decimal hours — first four relative to sunrise, last three to sunset. */
export const OFFSET_KEYS = [
  'dawnStart',
  'dawnEnd',
  'postDawnEnd',
  'morningEnd',
  'goldenStart',
  'twilightStart',
  'twilightEnd',
] as const;

export type OffsetKey = (typeof OFFSET_KEYS)[number];

export const ACCENT_KEYS = ['morning', 'evening', 'ongoing', 'accent'] as const;

export type AccentKey = (typeof ACCENT_KEYS)[number];

export type Accents = Record<AccentKey, string>;

/** Which theme mode is active. Light = the postDawn (lavender) palette;
 * Dark = the twilight (indigo) palette; sky = the full color runway;
 * off = leave the static CSS variable defaults alone. */
export type ThemeMode = 'auto' | 'light' | 'dark' | 'sky' | 'off';

/**
 * Saved overrides — the exact shape POSTed to /api/theme/save, persisted in
 * theme_settings.json (routes/settings.py) and injected back as
 * window.THEME_OVERRIDES by routes/spa.py. Every field optional: the server
 * whitelists these six top-level keys and stores whatever subset was sent.
 */
export interface ThemeOverrides {
  enabled?: boolean;
  mode?: ThemeMode;
  themes?: Partial<Record<PhaseName, Partial<PhaseColors>>>;
  offsets?: Partial<Record<OffsetKey, number>>;
  phasesEnabled?: Partial<Record<PhaseName, boolean>>;
  accents?: Partial<Accents>;
}

// Theme palettes — defaults. Saved overrides from /settings merge over these.
export const SKY_DEFAULT_THEMES: Record<PhaseName, PhaseColors> = {
  night: {
    bg: '#0d0d1a', cardBg: '#1a1a2e', text: '#e8dcc8', textSecondary: 'rgba(220,210,195,0.75)',
    textMuted: 'rgba(180,170,155,0.5)', border: '#2a2a4a',
  },
  dawn: {
    bg: '#1a1520', cardBg: '#2a2030', text: '#f5ede5', textSecondary: 'rgba(240,220,210,0.85)',
    textMuted: 'rgba(215,195,180,0.6)', border: '#3a2a3a',
  },
  postDawn: {
    bg: '#aba3b2', cardBg: '#b8b1c2', text: '#1a1815', textSecondary: '#2a2522',
    textMuted: 'rgba(30,25,20,0.6)', border: '#888391',
  },
  morning: {
    bg: '#eeeae4', cardBg: '#f8f6f2', text: '#1a1815', textSecondary: '#45403a',
    textMuted: '#8a8278', border: '#d8d2c8',
  },
  day: {
    bg: '#f7f4ef', cardBg: '#fff', text: '#2a2822', textSecondary: '#5a5650',
    textMuted: '#9a968e', border: '#e2ddd5',
  },
  golden: {
    bg: '#1e1812', cardBg: '#2e2518', text: '#f0dcc0', textSecondary: 'rgba(230,210,180,0.8)',
    textMuted: 'rgba(200,180,150,0.55)', border: '#3e3020',
  },
  twilight: {
    bg: '#14101e', cardBg: '#1e1830', text: '#ddd0e8', textSecondary: 'rgba(200,185,220,0.75)',
    textMuted: 'rgba(170,155,190,0.5)', border: '#2e2545',
  },
};

// Default boundary offsets — relative to sunrise (first 4) or sunset (last 3).
export const SKY_DEFAULT_OFFSETS: Record<OffsetKey, number> = {
  dawnStart: -1, dawnEnd: 0.25, postDawnEnd: 0.75, morningEnd: 2,
  goldenStart: -1.5, twilightStart: 0, twilightEnd: 1,
};

export const SKY_DEFAULT_ACCENTS: Accents = {
  morning: '#d4880a', evening: '#6a7acc', ongoing: '#3a9e8c', accent: '#7c5cbf',
};
