import { describe, expect, it } from 'vitest';
import { shouldOpenGuideOnLoad } from './guideOpenPref';

describe('shouldOpenGuideOnLoad', () => {
  it('opens for a first-time visitor', () => {
    expect(shouldOpenGuideOnLoad({ visitor: true, embed: false, dismissed: false })).toBe(true);
  });

  it('stays closed once a visitor has dismissed it', () => {
    expect(shouldOpenGuideOnLoad({ visitor: true, embed: false, dismissed: true })).toBe(false);
  });

  it('stays closed for the owner', () => {
    expect(shouldOpenGuideOnLoad({ visitor: false, embed: false, dismissed: false })).toBe(false);
  });

  it('never opens inside the embed card', () => {
    expect(shouldOpenGuideOnLoad({ visitor: true, embed: true, dismissed: false })).toBe(false);
  });
});
