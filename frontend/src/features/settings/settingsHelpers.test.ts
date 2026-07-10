import { describe, expect, it } from 'vitest';
import { SKY_DEFAULT_OFFSETS, SKY_DEFAULT_THEMES } from '../../theme/palettes';
import {
  buildSavePayload,
  draftFromOverrides,
  effectiveAccent,
  effectiveColor,
  effectiveOffset,
  hexWithAlphaFrom,
  normalizeHexForPicker,
  rgbaToHex,
  trimEmpty,
} from './settingsHelpers';

describe('draftFromOverrides', () => {
  it('fills every group and defaults enabled/mode', () => {
    const draft = draftFromOverrides({});
    expect(draft).toEqual({
      enabled: true,
      mode: 'sky',
      themes: {},
      offsets: {},
      phasesEnabled: {},
      accents: {},
    });
  });

  it('keeps saved values and deep-clones them', () => {
    const overrides = { enabled: false, mode: 'dark' as const, themes: { night: { bg: '#111111' } } };
    const draft = draftFromOverrides(overrides);
    expect(draft.enabled).toBe(false);
    expect(draft.mode).toBe('dark');
    expect(draft.themes.night?.bg).toBe('#111111');
    draft.themes.night!.bg = '#222222';
    expect(overrides.themes.night.bg).toBe('#111111'); // original untouched
  });
});

describe('trimEmpty', () => {
  it('drops empty-string/null/undefined leaves inside sub-objects', () => {
    expect(trimEmpty({ night: { bg: '#111111', text: '' }, dawn: {} })).toEqual({
      night: { bg: '#111111' },
    });
  });

  it('keeps scalar values, including 0 and false', () => {
    expect(trimEmpty({ a: 0, b: false, c: '', d: 'x' })).toEqual({ a: 0, b: false, d: 'x' });
  });
});

describe('buildSavePayload', () => {
  it('emits all six whitelisted keys with trimmed groups', () => {
    const draft = draftFromOverrides({});
    draft.themes = { night: { bg: '#111111', text: '' }, dawn: {} };
    draft.offsets = { dawnStart: 0 };
    draft.phasesEnabled = { day: false };
    const payload = buildSavePayload(draft);
    expect(payload).toEqual({
      enabled: true,
      mode: 'sky',
      themes: { night: { bg: '#111111' } },
      offsets: { dawnStart: 0 },
      phasesEnabled: { day: false },
      accents: {},
    });
  });
});

describe('effective values', () => {
  const draft = draftFromOverrides({
    themes: { night: { bg: '#010203' } },
    offsets: { dawnEnd: 0.5 },
    accents: { accent: '#abcdef' },
  });

  it('prefer the draft value, fall back to the engine default', () => {
    expect(effectiveColor(draft, 'night', 'bg')).toBe('#010203');
    expect(effectiveColor(draft, 'night', 'text')).toBe(SKY_DEFAULT_THEMES.night.text);
    expect(effectiveOffset(draft, 'dawnEnd')).toBe(0.5);
    expect(effectiveOffset(draft, 'dawnStart')).toBe(SKY_DEFAULT_OFFSETS.dawnStart);
    expect(effectiveAccent(draft, 'accent')).toBe('#abcdef');
    expect(effectiveAccent(draft, 'morning')).toBe('#d4880a');
  });

  it('offset 0 in the draft is honored (not treated as unset)', () => {
    const d = draftFromOverrides({ offsets: { dawnStart: 0 } });
    expect(effectiveOffset(d, 'dawnStart')).toBe(0);
  });
});

describe('rgbaToHex', () => {
  it('converts rgba to display hex, dropping alpha', () => {
    expect(rgbaToHex('rgba(220,210,195,0.75)')).toBe('#dcd2c3');
  });

  it('falls back to black on garbage', () => {
    expect(rgbaToHex('nope')).toBe('#000000');
  });
});

describe('hexWithAlphaFrom', () => {
  it('applies picker RGB while keeping the current alpha', () => {
    expect(hexWithAlphaFrom('#dcd2c3', 'rgba(1,2,3,0.6)')).toBe('rgba(220,210,195,0.6)');
  });

  it('defaults alpha to 1 when the current value has none to give', () => {
    expect(hexWithAlphaFrom('#102030', 'zzz')).toBe('rgba(16,32,48,1)');
  });
});

describe('normalizeHexForPicker', () => {
  it('passes long hex through, expands shorthand, converts rgba', () => {
    expect(normalizeHexForPicker('#a1b2c3')).toBe('#a1b2c3');
    expect(normalizeHexForPicker('#fff')).toBe('#ffffff');
    expect(normalizeHexForPicker('rgba(255,0,0,0.5)')).toBe('#ff0000');
    expect(normalizeHexForPicker('salmon')).toBe('#000000');
  });
});
