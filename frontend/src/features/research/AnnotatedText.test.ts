/**
 * AnnotatedText.test.ts — the pure mark layout behind AnnotatedText.tsx:
 * layoutMarks() runs anchor.ts's markSegments over a doc's annotations and
 * flags the active one. No DOM — the renderer maps these segments straight
 * to <mark>/<span>, so if the layout is right the marks are right.
 */

import { describe, expect, it } from 'vitest';
import { layoutMarks } from './AnnotatedText';
import { sourcePaneAnnotations } from './ClaimsPage';
import type { Annotation } from './types';

const TEXT = 'The quick brown fox jumps over the lazy dog';

function annotation(id: string, start: number, end: number, extra: Partial<Annotation> = {}): Annotation {
  return { id, doc: 'entry:x', selector: { exact: TEXT.slice(start, end), char_start: start, char_end: end }, ...extra };
}

describe('layoutMarks', () => {
  it('returns the whole text as one plain segment when there are no annotations', () => {
    expect(layoutMarks(TEXT, [], null)).toEqual([{ text: TEXT }]);
  });

  it('lays marks over the text in order and flags the active one', () => {
    const segments = layoutMarks(TEXT, [annotation('b', 16, 19), annotation('a', 4, 9, { needs_review: true })], 'b');
    expect(segments).toEqual([
      { text: 'The ' },
      { text: 'quick', mark: { id: 'a', needsReview: true, active: false } },
      { text: ' brown ' },
      { text: 'fox', mark: { id: 'b', needsReview: false, active: true } },
      { text: ' jumps over the lazy dog' },
    ]);
  });

  it('drops the mark of an annotation that overlaps an earlier one', () => {
    const segments = layoutMarks(TEXT, [annotation('a', 4, 15), annotation('b', 10, 19)], null);
    expect(segments.filter((segment) => segment.mark).map((segment) => segment.mark!.id)).toEqual(['a']);
  });

  it('skips lost annotations but keeps the text whole', () => {
    const segments = layoutMarks(TEXT, [annotation('gone', 4, 9, { state: 'lost' })], 'gone');
    expect(segments).toEqual([{ text: TEXT }]);
  });
});

describe('sourcePaneAnnotations', () => {
  const linked = { id: 'link', doc: 'entry:x', char_start: 4, char_end: 9, exact: 'quick', note: '' };

  it('leaves the fetched list alone when it already carries the linked passage', () => {
    const fetched = [annotation('link', 4, 9)];
    expect(sourcePaneAnnotations(TEXT, fetched, linked)).toBe(fetched);
  });

  it('adds the linked passage, resolved against the live text, when the list lacks it', () => {
    const drifted = { ...linked, char_start: 0, char_end: 5 };
    const out = sourcePaneAnnotations(TEXT, [], drifted);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('link');
    expect(out[0].state).toBe('relocated');
    expect(out[0].selector).toEqual({ exact: 'quick', char_start: 4, char_end: 9 });
  });
});
