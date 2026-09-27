import { describe, expect, it } from 'vitest';
import { isFoodRequested, normalizeFoodName } from './requestLink';

const open = { food_ids: [7], names: ['green beans'] };

describe('isFoodRequested', () => {
  it('matches a requested food by id', () => {
    expect(isFoodRequested(open, 7, 'anything')).toBe(true);
  });

  it('matches a food with no id by its normalized name', () => {
    expect(isFoodRequested(open, null, '  Green   Beans ')).toBe(true);
  });

  it('is false with no marker (public viewers)', () => {
    expect(isFoodRequested(undefined, 7, 'green beans')).toBe(false);
  });

  it('is false for a food nobody asked about', () => {
    expect(isFoodRequested(open, 8, 'kale')).toBe(false);
  });
});

describe('normalizeFoodName', () => {
  it('trims, lowercases and collapses spaces like foodstore._norm', () => {
    expect(normalizeFoodName('  Red\t Onion ')).toBe('red onion');
  });
});
