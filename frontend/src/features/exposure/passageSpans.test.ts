import { describe, expect, it } from 'vitest';
import { passageSpans } from './passageSpans';

describe('passageSpans', () => {
  it('finds a passage spread over pieces despite different spacing', () => {
    const pieces = ['Carrots (708)', ' ', '46.0', 'Broccoli (708)', '21.0'];
    expect(passageSpans(pieces, 'Broccoli (708)                   21.0')).toEqual([3, 4]);
  });

  it('marks a piece the passage only partly covers', () => {
    expect(passageSpans(['alpha beta', 'gamma delta'], 'beta gamma')).toEqual([0, 1]);
  });

  it('returns nothing when the passage is not on the page', () => {
    expect(passageSpans(['one', 'two'], 'three')).toEqual([]);
  });
});
