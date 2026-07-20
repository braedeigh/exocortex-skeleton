/**
 * settingsHelpers.ts — pure logic behind the Settings page, ported from
 * static/js/settings.js: the editable draft built from window.THEME_OVERRIDES,
 * effective-value lookups (draft value or engine default), the trimmed
 * /api/theme/save payload, and the rgba↔hex conversions the paired
 * color/text inputs need.
 */
import {
  SKY_DEFAULT_ACCENTS,
  SKY_DEFAULT_OFFSETS,
  SKY_DEFAULT_THEMES,
  type AccentKey,
  type Accents,
  type ColorKey,
  type OffsetKey,
  type PhaseColors,
  type PhaseName,
  type ThemeMode,
  type ThemeOverrides,
} from '../../theme/palettes';

/** The Settings page's working copy of the overrides — every group always
 * present (legacy `state.X ??= {}`), scalars defaulted. */
export interface ThemeDraft {
  enabled: boolean;
  mode: ThemeMode;
  themes: Partial<Record<PhaseName, Partial<PhaseColors>>>;
  offsets: Partial<Record<OffsetKey, number>>;
  phasesEnabled: Partial<Record<PhaseName, boolean>>;
  accents: Partial<Accents>;
}

/** Deep-clone the saved overrides into an editable draft (legacy
 * initSettingsPanel's JSON round-trip + `??=` defaults). */
export function draftFromOverrides(overrides: ThemeOverrides): ThemeDraft {
  const clone = JSON.parse(JSON.stringify(overrides ?? {})) as ThemeOverrides;
  return {
    enabled: clone.enabled !== false,
    mode: clone.mode ?? 'sky',
    themes: clone.themes ?? {},
    offsets: clone.offsets ?? {},
    phasesEnabled: clone.phasesEnabled ?? {},
    accents: clone.accents ?? {},
  };
}

/** Drop empty strings/null/undefined leaves and empty sub-objects — the
 * exact trimEmpty() the legacy save handler ran over each override group. */
export function trimEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const kk of Object.keys(v)) {
        const vv = (v as Record<string, unknown>)[kk];
        if (vv !== undefined && vv !== null && vv !== '') inner[kk] = vv;
      }
      if (Object.keys(inner).length) out[k] = inner;
    } else if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

/** The exact body POSTed to /api/theme/save (and handed to the engine as the
 * new live overrides) — same six whitelisted keys the server stores. */
export function buildSavePayload(draft: ThemeDraft): ThemeOverrides {
  return {
    enabled: draft.enabled,
    mode: draft.mode || 'sky',
    themes: trimEmpty(draft.themes),
    offsets: trimEmpty(draft.offsets),
    phasesEnabled: trimEmpty(draft.phasesEnabled),
    accents: trimEmpty(draft.accents),
  };
}

export function effectiveColor(draft: ThemeDraft, phase: PhaseName, key: ColorKey): string {
  return draft.themes[phase]?.[key] ?? SKY_DEFAULT_THEMES[phase][key];
}

export function effectiveOffset(draft: ThemeDraft, key: OffsetKey): number {
  return draft.offsets[key] ?? SKY_DEFAULT_OFFSETS[key];
}

export function effectiveAccent(draft: ThemeDraft, key: AccentKey): string {
  return draft.accents[key] ?? SKY_DEFAULT_ACCENTS[key];
}

/** 'rgba(220,210,195,0.75)' → '#dcd2c3' — what the color picker shows for an
 * rgba-typed value (alpha dropped for display only). */
export function rgbaToHex(rgba: string): string {
  const m = rgba.match(/[\d.]+/g);
  if (!m) return '#000000';
  return (
    '#' +
    m
      .slice(0, 3)
      .map((n) => Math.round(parseFloat(n)).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * A color-picker edit on an rgba-typed value keeps the current alpha:
 * '#dcd2c3' + current 'rgba(...,0.75)' → 'rgba(220,210,195,0.75)'. Falls
 * back to the hex unchanged if it doesn't parse (legacy behavior).
 */
export function hexWithAlphaFrom(hex: string, current: string): string {
  const alpha = (current.match(/[\d.]+/g) ?? ['0', '0', '0', '1'])[3] ?? '1';
  const m = hex.match(/[0-9a-f]{2}/gi);
  if (!m) return hex;
  return `rgba(${parseInt(m[0], 16)},${parseInt(m[1], 16)},${parseInt(m[2], 16)},${alpha})`;
}

/** <input type="color"> only accepts #rrggbb — expand shorthand (#fff) and
 * fall back to black for anything unparsable, display-only. */
export function normalizeHexForPicker(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const short = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (value.startsWith('rgba')) return rgbaToHex(value);
  return '#000000';
}

/**
 * Profile section — which fields to PUT /api/profile. Inputs hold the raw
 * text (empty means "inherit/clear"); `stored` is the server's explicitly-set
 * subset. Only keys whose input value actually differs from what's stored go
 * in the diff (an untouched, already-inherited field stays untouched rather
 * than sending a redundant "" clear), keeping the request minimal and the
 * clear-vs-leave-alone distinction correct.
 */
export function profileChangedFields<K extends string>(
  inputs: Record<K, string>,
  stored: Partial<Record<K, string>>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of Object.keys(inputs) as K[]) {
    const value = inputs[key];
    const storedValue = stored[key] ?? '';
    if (value !== storedValue) out[key] = value;
  }
  return out;
}
