import { describe, expect, it } from 'vitest';
import {
  annotationMarkInputs,
  makeSelector,
  markSegments,
  relocateSelector,
  resolveSelector,
  verifySelector,
} from './anchor';
import type { Annotation } from './types';

const TEXT = 'The quick brown fox jumps over the lazy dog';

describe('makeSelector', () => {
  it('captures the exact slice for a valid range', () => {
    expect(makeSelector(TEXT, 4, 9)).toEqual({ exact: 'quick', char_start: 4, char_end: 9 });
  });

  it('rejects out-of-bounds, inverted, and empty ranges', () => {
    expect(makeSelector(TEXT, -1, 5)).toBeNull();
    expect(makeSelector(TEXT, 5, 5)).toBeNull();
    expect(makeSelector(TEXT, 9, 4)).toBeNull();
    expect(makeSelector(TEXT, 0, TEXT.length + 1)).toBeNull();
    expect(makeSelector('', 0, 1)).toBeNull();
  });

  it('rejects non-finite offsets and truncates fractional ones', () => {
    expect(makeSelector(TEXT, Number.NaN, 5)).toBeNull();
    expect(makeSelector(TEXT, 0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(makeSelector(TEXT, 4.9, 9.9)).toEqual({ exact: 'quick', char_start: 4, char_end: 9 });
  });
});

describe('verifySelector', () => {
  it('accepts a selector whose slice still matches', () => {
    expect(verifySelector(TEXT, { exact: 'quick', char_start: 4, char_end: 9 })).toBe(true);
  });

  it('rejects a drifted selector', () => {
    expect(verifySelector(TEXT, { exact: 'quick', char_start: 5, char_end: 10 })).toBe(false);
  });

  it('never throws on malformed shapes', () => {
    expect(verifySelector(TEXT, null)).toBe(false);
    expect(verifySelector(TEXT, {})).toBe(false);
    expect(verifySelector(TEXT, { exact: '', char_start: 0, char_end: 3 })).toBe(false);
    expect(verifySelector(TEXT, { exact: 'The', char_start: '0', char_end: 3 })).toBe(false);
    expect(verifySelector(TEXT, { exact: 'The', char_start: 0.5, char_end: 3 })).toBe(false);
  });
});

describe('relocateSelector (re-anchoring after doc edits)', () => {
  it('finds the moved quote after text is inserted before it', () => {
    const sel = makeSelector(TEXT, 4, 9)!; // 'quick'
    const edited = `NEW PREFIX. ${TEXT}`;
    expect(relocateSelector(edited, sel)).toEqual({
      exact: 'quick',
      char_start: 4 + 'NEW PREFIX. '.length,
      char_end: 9 + 'NEW PREFIX. '.length,
    });
  });

  it('picks the occurrence nearest the original offset', () => {
    const text = 'abc X abc Y abc';
    // Original anchored at the middle 'abc' (index 6).
    const sel = { exact: 'abc', char_start: 7, char_end: 10 };
    expect(relocateSelector(text, sel)).toEqual({ exact: 'abc', char_start: 6, char_end: 9 });
  });

  it('breaks exact distance ties toward the earlier occurrence', () => {
    const text = 'ab cd ab';
    // char_start 3 is equidistant (3) from occurrences at 0 and 6.
    const sel = { exact: 'ab', char_start: 3, char_end: 5 };
    expect(relocateSelector(text, sel)).toEqual({ exact: 'ab', char_start: 0, char_end: 2 });
  });

  it('returns null when the quote no longer occurs', () => {
    expect(relocateSelector('nothing to see', { exact: 'quick', char_start: 4, char_end: 9 })).toBeNull();
  });
});

describe('resolveSelector', () => {
  it('verifies an intact selector', () => {
    const sel = { exact: 'lazy', char_start: 35, char_end: 39 };
    expect(resolveSelector(TEXT, sel)).toEqual({ state: 'verified', selector: sel });
  });

  it('relocates a shifted selector', () => {
    const sel = { exact: 'lazy', char_start: 2, char_end: 6 };
    const r = resolveSelector(TEXT, sel);
    expect(r.state).toBe('relocated');
    expect(r.selector).toEqual({ exact: 'lazy', char_start: 35, char_end: 39 });
  });

  it('marks a vanished quote lost, keeping the original selector', () => {
    const sel = { exact: 'gone', char_start: 0, char_end: 4 };
    expect(resolveSelector(TEXT, sel)).toEqual({ state: 'lost', selector: sel });
  });
});

describe('markSegments (highlight range merging)', () => {
  const seg = (id: string, s: number, e: number, needsReview = false) => ({
    id,
    selector: { exact: TEXT.slice(s, e), char_start: s, char_end: e },
    needsReview,
  });

  it('returns the whole text as one plain segment with no marks', () => {
    expect(markSegments(TEXT, [])).toEqual([{ text: TEXT }]);
  });

  it('splits around a single mark', () => {
    expect(markSegments(TEXT, [seg('a', 4, 9, true)])).toEqual([
      { text: 'The ' },
      { text: 'quick', mark: { id: 'a', needsReview: true } },
      { text: ' brown fox jumps over the lazy dog' },
    ]);
  });

  it('keeps adjacent marks and drops overlapping ones (greedy by start)', () => {
    const segs = markSegments(TEXT, [seg('b', 8, 15), seg('a', 4, 10), seg('c', 10, 15)]);
    // 'a' [4,10) wins by earlier start; 'b' [8,15) overlaps and loses its
    // mark; 'c' [10,15) starts exactly where 'a' ended and keeps its mark.
    expect(segs).toEqual([
      { text: 'The ' },
      { text: TEXT.slice(4, 10), mark: { id: 'a', needsReview: false } },
      { text: TEXT.slice(10, 15), mark: { id: 'c', needsReview: false } },
      { text: TEXT.slice(15) },
    ]);
  });

  it('on identical ranges keeps only the first', () => {
    const segs = markSegments(TEXT, [seg('x', 4, 9), seg('y', 4, 9)]);
    expect(segs.filter((s) => s.mark).map((s) => s.mark!.id)).toEqual(['x']);
  });

  it('filters lost/unresolved states, missing selectors, and bad offsets', () => {
    const segs = markSegments(TEXT, [
      { ...seg('lost', 4, 9), state: 'lost' as const },
      { ...seg('unres', 4, 9), state: 'unresolved' as const },
      { id: 'nosel', selector: null, needsReview: false },
      { id: 'oob', selector: { exact: 'x', char_start: 40, char_end: 99 }, needsReview: false },
      { id: 'inverted', selector: { exact: 'x', char_start: 9, char_end: 4 }, needsReview: false },
      { id: 'frac', selector: { exact: 'x', char_start: 1.5, char_end: 3 }, needsReview: false },
      seg('ok', 0, 3),
    ]);
    expect(segs.filter((s) => s.mark).map((s) => s.mark!.id)).toEqual(['ok']);
  });

  it('round-trips segment text back to the document', () => {
    const segs = markSegments(TEXT, [seg('a', 4, 9), seg('b', 16, 19), seg('c', 40, 43)]);
    expect(segs.map((s) => s.text).join('')).toBe(TEXT);
  });
});

describe('annotationMarkInputs', () => {
  it('maps server annotations onto mark inputs', () => {
    const anns: Annotation[] = [
      {
        id: 'ann-1',
        doc: 'entry:e1',
        needs_review: true,
        state: 'relocated',
        selector: { exact: 'quick', char_start: 4, char_end: 9 },
      },
      { id: 'ann-2', doc: 'entry:e1', selector: null },
    ];
    expect(annotationMarkInputs(anns)).toEqual([
      {
        id: 'ann-1',
        selector: { exact: 'quick', char_start: 4, char_end: 9 },
        state: 'relocated',
        needsReview: true,
      },
      { id: 'ann-2', selector: null, state: undefined, needsReview: false },
    ]);
  });
});
