import { describe, expect, it } from 'vitest';
import { blendThemes } from './blend';
import { SKY_DEFAULT_ACCENTS, SKY_DEFAULT_OFFSETS, SKY_DEFAULT_THEMES } from './palettes';
import { computeModeTheme, computeRunwayTheme, currentThemeMode, resolveSkyConfig } from './resolve';
import { sunTimesFromDay } from './solar';

describe('resolveSkyConfig', () => {
  it('with no overrides returns the defaults, enabled', () => {
    const cfg = resolveSkyConfig({});
    expect(cfg.themes.night).toEqual(SKY_DEFAULT_THEMES.night);
    expect(cfg.offsets).toEqual(SKY_DEFAULT_OFFSETS);
    expect(cfg.accents).toEqual(SKY_DEFAULT_ACCENTS);
    expect(cfg.enabled).toBe(true);
  });

  it('merges per-phase color overrides over defaults, key by key', () => {
    const cfg = resolveSkyConfig({ themes: { night: { bg: '#111111' } } });
    expect(cfg.themes.night.bg).toBe('#111111');
    expect(cfg.themes.night.text).toBe(SKY_DEFAULT_THEMES.night.text);
    expect(cfg.themes.dawn).toEqual(SKY_DEFAULT_THEMES.dawn);
  });

  it('merges offset and accent overrides', () => {
    const cfg = resolveSkyConfig({ offsets: { dawnStart: -2 }, accents: { accent: '#ff0000' } });
    expect(cfg.offsets.dawnStart).toBe(-2);
    expect(cfg.offsets.dawnEnd).toBe(SKY_DEFAULT_OFFSETS.dawnEnd);
    expect(cfg.accents.accent).toBe('#ff0000');
    expect(cfg.accents.morning).toBe(SKY_DEFAULT_ACCENTS.morning);
  });

  it('a disabled phase inherits the next enabled phase (day order)', () => {
    const cfg = resolveSkyConfig({ phasesEnabled: { dawn: false } });
    expect(cfg.runwayThemes.dawn).toEqual(SKY_DEFAULT_THEMES.postDawn);
  });

  it('consecutive disabled phases chain to the first enabled one', () => {
    const cfg = resolveSkyConfig({ phasesEnabled: { dawn: false, postDawn: false } });
    expect(cfg.runwayThemes.dawn).toEqual(SKY_DEFAULT_THEMES.morning);
    expect(cfg.runwayThemes.postDawn).toEqual(SKY_DEFAULT_THEMES.morning);
  });

  it('disabling the last phase wraps around to the first', () => {
    const cfg = resolveSkyConfig({ phasesEnabled: { twilight: false } });
    expect(cfg.runwayThemes.twilight).toEqual(SKY_DEFAULT_THEMES.night);
  });

  it('inheritance uses the overridden colors of the inherited phase', () => {
    const cfg = resolveSkyConfig({
      phasesEnabled: { dawn: false },
      themes: { postDawn: { bg: '#123456' } },
    });
    expect(cfg.runwayThemes.dawn.bg).toBe('#123456');
  });

  it('disabling a phase leaves the un-inherited palettes alone', () => {
    const cfg = resolveSkyConfig({ phasesEnabled: { dawn: false } });
    expect(cfg.themes.dawn).toEqual(SKY_DEFAULT_THEMES.dawn);
  });

  it('enabled false comes through; anything else means enabled', () => {
    expect(resolveSkyConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveSkyConfig({}).enabled).toBe(true);
  });
});

describe('currentThemeMode', () => {
  it('explicit override mode wins over everything', () => {
    expect(currentThemeMode({ mode: 'dark' }, 'light')).toBe('dark');
  });

  it('falls back to the stored mode', () => {
    expect(currentThemeMode({}, 'auto')).toBe('auto');
  });

  it('defaults to auto when enabled, off when master-disabled', () => {
    expect(currentThemeMode({}, null)).toBe('auto');
    expect(currentThemeMode({ enabled: false }, null)).toBe('off');
  });
});

describe('computeModeTheme', () => {
  const cfg = resolveSkyConfig({});
  const day = 100;
  const { sunrise, sunset } = sunTimesFromDay(day);

  it("'off' applies nothing", () => {
    expect(computeModeTheme(cfg, 'off', 12, day)).toBeNull();
  });

  it("'light' is postDawn, 'dark' is twilight, regardless of time", () => {
    expect(computeModeTheme(cfg, 'light', 3, day)).toEqual(cfg.themes.postDawn);
    expect(computeModeTheme(cfg, 'dark', 12, day)).toEqual(cfg.themes.twilight);
  });

  it("'auto' is postDawn between sunrise and sunset, twilight otherwise", () => {
    expect(computeModeTheme(cfg, 'auto', sunrise + 1, day)).toEqual(cfg.themes.postDawn);
    expect(computeModeTheme(cfg, 'auto', sunrise - 0.1, day)).toEqual(cfg.themes.twilight);
    expect(computeModeTheme(cfg, 'auto', sunset, day)).toEqual(cfg.themes.twilight);
  });

  it("'sky' with the master toggle off applies nothing", () => {
    const disabled = resolveSkyConfig({ enabled: false });
    expect(computeModeTheme(disabled, 'sky', 12, day)).toBeNull();
  });

  it("'sky' with the toggle on delegates to the runway", () => {
    expect(computeModeTheme(cfg, 'sky', 12, day)).toEqual(computeRunwayTheme(cfg, 12, day));
  });
});

describe('computeRunwayTheme', () => {
  const cfg = resolveSkyConfig({});
  const day = 100;
  const { sunrise, sunset } = sunTimesFromDay(day);
  const o = cfg.offsets;

  it('night before dawnStart and at/after twilightEnd', () => {
    expect(computeRunwayTheme(cfg, sunrise + o.dawnStart - 0.01, day)).toEqual(cfg.themes.night);
    expect(computeRunwayTheme(cfg, sunset + o.twilightEnd, day)).toEqual(cfg.themes.night);
    expect(computeRunwayTheme(cfg, 0, day)).toEqual(cfg.themes.night);
  });

  it('night→dawn blend inside the dawn window', () => {
    const dawnStart = sunrise + o.dawnStart;
    const dawnEnd = sunrise + o.dawnEnd;
    const mid = (dawnStart + dawnEnd) / 2;
    expect(computeRunwayTheme(cfg, mid, day)).toEqual(
      blendThemes(cfg.themes.night, cfg.themes.dawn, 0.5),
    );
  });

  it('dawn→postDawn then postDawn→morning across the morning boundaries', () => {
    const dawnEnd = sunrise + o.dawnEnd;
    const postDawnEnd = sunrise + o.postDawnEnd;
    const morningEnd = sunrise + o.morningEnd;
    const hourA = (dawnEnd + postDawnEnd) / 2;
    const tA = (hourA - dawnEnd) / (postDawnEnd - dawnEnd); // ≈0.5, FP-identical to impl
    expect(computeRunwayTheme(cfg, hourA, day)).toEqual(
      blendThemes(cfg.themes.dawn, cfg.themes.postDawn, tA),
    );
    const hourB = (postDawnEnd + morningEnd) / 2;
    const tB = (hourB - postDawnEnd) / (morningEnd - postDawnEnd);
    expect(computeRunwayTheme(cfg, hourB, day)).toEqual(
      blendThemes(cfg.themes.postDawn, cfg.themes.morning, tB),
    );
  });

  it('pure day palette between morningEnd and goldenStart', () => {
    const hour = (sunrise + o.morningEnd + sunset + o.goldenStart) / 2;
    expect(computeRunwayTheme(cfg, hour, day)).toEqual(cfg.themes.day);
  });

  it('golden-hour curve holds the day look early (t = tRaw * 0.2 below 0.7)', () => {
    const goldenStart = sunset + o.goldenStart;
    const twilightStart = sunset + o.twilightStart;
    const hour = goldenStart + 0.5 * (twilightStart - goldenStart); // tRaw = 0.5
    expect(computeRunwayTheme(cfg, hour, day)).toEqual(
      blendThemes(cfg.themes.day, cfg.themes.golden, 0.1),
    );
  });

  it('golden-hour curve snaps toward golden after 0.7', () => {
    const goldenStart = sunset + o.goldenStart;
    const twilightStart = sunset + o.twilightStart;
    const hour = goldenStart + 0.85 * (twilightStart - goldenStart); // tRaw ≈ 0.85
    // recover tRaw exactly as the implementation does (FP-identical)
    const tRaw = (hour - goldenStart) / (twilightStart - goldenStart);
    const t = 0.14 + ((tRaw - 0.7) / 0.3) * 0.86;
    expect(computeRunwayTheme(cfg, hour, day)).toEqual(
      blendThemes(cfg.themes.day, cfg.themes.golden, t),
    );
  });

  it('twilight curve: dimmed hold below 0.7, snap to night after', () => {
    const twilightStart = sunset + o.twilightStart;
    const twilightEnd = sunset + o.twilightEnd;
    const early = twilightStart + 0.4 * (twilightEnd - twilightStart); // tRaw ≈ 0.4
    const tRawEarly = (early - twilightStart) / (twilightEnd - twilightStart);
    expect(computeRunwayTheme(cfg, early, day)).toEqual(
      blendThemes(cfg.themes.golden, cfg.themes.night, tRawEarly * 0.25),
    );
    const late = twilightStart + 0.9 * (twilightEnd - twilightStart); // tRaw ≈ 0.9
    const tRawLate = (late - twilightStart) / (twilightEnd - twilightStart);
    const t = 0.175 + ((tRawLate - 0.7) / 0.3) * 0.825;
    expect(computeRunwayTheme(cfg, late, day)).toEqual(
      blendThemes(cfg.themes.golden, cfg.themes.night, t),
    );
  });

  it('custom offsets move the boundaries', () => {
    const shifted = resolveSkyConfig({ offsets: { dawnStart: -3 } });
    const hour = sunrise - 2; // night under defaults, dawn-blend when dawnStart=-3
    expect(computeRunwayTheme(cfg, hour, day)).toEqual(cfg.themes.night);
    expect(computeRunwayTheme(shifted, hour, day)).not.toEqual(cfg.themes.night);
  });

  it('a disabled phase renders as its successor (visually transparent window)', () => {
    const cfgNoDay = resolveSkyConfig({ phasesEnabled: { day: false } });
    const hour = (sunrise + o.morningEnd + sunset + o.goldenStart) / 2;
    expect(computeRunwayTheme(cfgNoDay, hour, day)).toEqual(cfg.themes.golden);
  });
});

// Regression: per-phase disabling is a runway-only idea. It used to be baked
// into the single shared palette set, so turning off postDawn/morning/day made
// Light and daytime Auto render the golden (brown) palette instead of lavender.
describe('phase disabling stays out of the fixed modes', () => {
  const brownMaker = resolveSkyConfig({
    phasesEnabled: { postDawn: false, morning: false, day: false },
  });
  const noonDay = 239;
  const { sunrise } = sunTimesFromDay(noonDay);

  it('light mode keeps lavender when postDawn is disabled', () => {
    expect(computeModeTheme(brownMaker, 'light', sunrise + 4, noonDay)).toEqual(
      SKY_DEFAULT_THEMES.postDawn,
    );
  });

  it('auto by day keeps lavender when postDawn is disabled', () => {
    expect(computeModeTheme(brownMaker, 'auto', sunrise + 4, noonDay)).toEqual(
      SKY_DEFAULT_THEMES.postDawn,
    );
  });

  it('the runway still slides past the disabled window', () => {
    expect(brownMaker.runwayThemes.postDawn).toEqual(SKY_DEFAULT_THEMES.golden);
  });
});
