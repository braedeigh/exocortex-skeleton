import { describe, expect, it } from 'vitest';
import { embedFitPadding, isCompactFrame } from './embedLayout';

describe('exhibit frame size', () => {
  it('a portfolio card on a laptop is compact', () => {
    expect(isCompactFrame(670, 419)).toBe(true);
  });
  it('a card on a phone is compact', () => {
    expect(isCompactFrame(356, 223)).toBe(true);
  });
  it('the full-window exhibit is not', () => {
    expect(isCompactFrame(1200, 750)).toBe(false);
  });
  it('compact frames keep only a title band and a door band clear', () => {
    expect(embedFitPadding(670, 419)).toEqual({ paddingTopLeft: [16, 64], paddingBottomRight: [16, 64] });
  });
  it('a full frame keeps the caption and the key clear', () => {
    expect(embedFitPadding(1200, 750)).toEqual({ paddingTopLeft: [24, 150], paddingBottomRight: [24, 76] });
  });
});
