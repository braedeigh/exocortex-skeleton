import { describe, expect, it } from 'vitest';
import { isEmbedSearch } from './embed';

describe('isEmbedSearch', () => {
  it('accepts the URL as written and as the router rewrites it', () => {
    expect(isEmbedSearch('?embed=1')).toBe(true);
    expect(isEmbedSearch('?embed=true')).toBe(true);
    expect(isEmbedSearch('?journey=abc&embed=1')).toBe(true);
  });
  it('is off otherwise', () => {
    expect(isEmbedSearch('')).toBe(false);
    expect(isEmbedSearch('?embed=0')).toBe(false);
    expect(isEmbedSearch('?embed=')).toBe(false);
    expect(isEmbedSearch('?journey=abc')).toBe(false);
  });
});
