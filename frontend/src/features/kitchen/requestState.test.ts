import { describe, expect, it } from 'vitest';
import { isLinkRequested, normFoodName } from './requestState';

const requested = { food_ids: [7], names: ['wild rice'] };

describe('isLinkRequested', () => {
  it('matches a request filed by food id', () => {
    expect(isLinkRequested(requested, 7, 'Anything')).toBe(true);
  });

  it('matches a request filed by name, however the name is spaced or cased', () => {
    expect(isLinkRequested(requested, null, '  Wild   RICE ')).toBe(true);
  });

  it('is false for a food with no open request', () => {
    expect(isLinkRequested(requested, 8, 'Oats')).toBe(false);
  });

  it('is false when the payload carries no requests', () => {
    expect(isLinkRequested(undefined, 7, 'wild rice')).toBe(false);
  });
});

describe('normFoodName', () => {
  it('trims, lowercases and collapses spaces', () => {
    expect(normFoodName(' Sweet  Potato\t')).toBe('sweet potato');
  });
});
