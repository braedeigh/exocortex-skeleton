import { describe, expect, it } from 'vitest';
import { swapAdjacent, ytId, youtubeEmbedUrl, youtubeThumbUrl } from './movementHelpers';

const ID = 'dQw4w9WgXcQ';

describe('ytId', () => {
  it('parses a standard watch URL', () => {
    expect(ytId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('parses a watch URL where v is not the first param', () => {
    expect(ytId(`https://www.youtube.com/watch?t=42&v=${ID}&list=PL123`)).toBe(ID);
  });

  it('parses a youtu.be short link', () => {
    expect(ytId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(ytId(`https://youtu.be/${ID}?t=30`)).toBe(ID);
  });

  it('parses embed and shorts URLs', () => {
    expect(ytId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(ytId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
  });

  it('tolerates surrounding whitespace', () => {
    expect(ytId(`  https://www.youtube.com/watch?v=${ID}  `)).toBe(ID);
  });

  it('returns empty for non-YouTube URLs', () => {
    expect(ytId('https://vimeo.com/12345678')).toBe('');
    expect(ytId('https://example.com/watch?v=short')).toBe('');
  });

  it('returns empty for empty / missing input', () => {
    expect(ytId('')).toBe('');
    expect(ytId(null)).toBe('');
    expect(ytId(undefined)).toBe('');
  });

  it('requires exactly 11 id characters after the marker', () => {
    // Ten valid chars then end-of-string: no match.
    expect(ytId('https://youtu.be/abcdefghij')).toBe('');
    // Eleven valid chars followed by more id-alphabet chars: the first 11 win
    // (same as the old regex behavior).
    expect(ytId('https://youtu.be/abcdefghijkl')).toBe('abcdefghijk');
  });
});

describe('youtube URL builders', () => {
  it('builds the hqdefault thumbnail URL', () => {
    expect(youtubeThumbUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });

  it('builds the autoplay embed URL with the legacy params', () => {
    expect(youtubeEmbedUrl(ID)).toBe(
      `https://www.youtube.com/embed/${ID}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
    );
  });
});

describe('swapAdjacent', () => {
  const ids = ['a', 'b', 'c'];

  it('moves an item up', () => {
    expect(swapAdjacent(ids, 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('moves an item down', () => {
    expect(swapAdjacent(ids, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('returns null at the top edge', () => {
    expect(swapAdjacent(ids, 'a', -1)).toBeNull();
  });

  it('returns null at the bottom edge', () => {
    expect(swapAdjacent(ids, 'c', 1)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(swapAdjacent(ids, 'nope', 1)).toBeNull();
  });

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c'];
    swapAdjacent(input, 'a', 1);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});
