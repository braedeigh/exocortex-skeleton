import { describe, expect, it } from 'vitest';
import { resolveAll, resolveHighlight } from './highlightMarks';

/**
 * The pure half of highlightMarks.ts — where a saved highlight lands in text
 * that may have moved under it. The DOM half (walking text nodes, wrapping
 * <mark>) isn't covered here; this is the part with decisions in it.
 */

describe('resolveHighlight', () => {
  it('uses the stored offsets when they still land on the quote', () => {
    const text = 'the field is fallow';
    expect(resolveHighlight(text, { start: 4, end: 9, quote: 'field' })).toEqual({ start: 4, end: 9 });
  });

  it('re-finds the quote when the text shifted under it', () => {
    // A reply that grew a preamble after the mark was made.
    const text = 'and so: the field is fallow';
    expect(resolveHighlight(text, { start: 4, end: 9, quote: 'field' })).toEqual({ start: 12, end: 17 });
  });

  it('lights nothing when the quoted words are gone', () => {
    expect(resolveHighlight('something else entirely', { start: 4, end: 9, quote: 'field' })).toBeNull();
  });

  it('falls back to raw offsets when there is no quote to check against', () => {
    expect(resolveHighlight('abcdefgh', { start: 2, end: 5, quote: '' })).toEqual({ start: 2, end: 5 });
  });

  it('refuses out-of-bounds offsets with no quote rather than guessing', () => {
    expect(resolveHighlight('abc', { start: 2, end: 99, quote: '' })).toBeNull();
    expect(resolveHighlight('abc', { start: 3, end: 3, quote: '' })).toBeNull();
  });
});

describe('resolveAll', () => {
  it('sorts by position so the painter can walk forward once', () => {
    const text = 'one two three';
    const out = resolveAll(text, [
      { start: 8, end: 13, quote: 'three' },
      { start: 0, end: 3, quote: 'one' },
    ]);
    expect(out).toEqual([{ start: 0, end: 3 }, { start: 8, end: 13 }]);
  });

  it('merges overlapping and touching marks into one lit stretch', () => {
    const text = 'one two three';
    const out = resolveAll(text, [
      { start: 0, end: 7, quote: 'one two' },
      { start: 4, end: 13, quote: 'two three' },
    ]);
    expect(out).toEqual([{ start: 0, end: 13 }]);
  });

  it('drops the marks that no longer resolve and keeps the ones that do', () => {
    const out = resolveAll('one two three', [
      { start: 0, end: 3, quote: 'one' },
      { start: 0, end: 4, quote: 'gone' },
    ]);
    expect(out).toEqual([{ start: 0, end: 3 }]);
  });
});
