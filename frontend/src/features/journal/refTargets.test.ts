import { describe, expect, it } from 'vitest';
import { classifyRef, refLabel } from './refTargets';

describe('classifyRef', () => {
  it('classifies a journal date', () => {
    expect(classifyRef('2026-05-14')).toEqual({ type: 'date', date: '2026-05-14' });
  });

  it('classifies a person file path', () => {
    expect(classifyRef('people/vivian.md')).toEqual({ type: 'person', slug: 'vivian' });
  });

  it('classifies a multi-word slug person file path', () => {
    expect(classifyRef('people/john-doe.md')).toEqual({ type: 'person', slug: 'john-doe' });
  });

  it('falls back to file for anything else', () => {
    expect(classifyRef('THREADS.md')).toEqual({ type: 'file', path: 'THREADS.md' });
  });

  it('falls back to file for a nested path', () => {
    expect(classifyRef('Journal/Daily/2026-07-07.md')).toEqual({
      type: 'file',
      path: 'Journal/Daily/2026-07-07.md',
    });
  });

  it('does not treat a people path outside people/ as person', () => {
    expect(classifyRef('archive/people/vivian.md')).toEqual({
      type: 'file',
      path: 'archive/people/vivian.md',
    });
  });

  it('does not treat a nested people path as person', () => {
    expect(classifyRef('people/nested/vivian.md')).toEqual({
      type: 'file',
      path: 'people/nested/vivian.md',
    });
  });

  it('rejects a malformed date-like string', () => {
    expect(classifyRef('2026-5-14')).toEqual({ type: 'file', path: '2026-5-14' });
  });
});

describe('refLabel', () => {
  it('renders a short "Month D" label for a date target, no leading zero', () => {
    expect(refLabel({ type: 'date', date: '2026-05-14' })).toBe('May 14');
    expect(refLabel({ type: 'date', date: '2026-01-05' })).toBe('January 5');
    expect(refLabel({ type: 'date', date: '2026-12-31' })).toBe('December 31');
  });

  it('prettifies a single-word person slug', () => {
    expect(refLabel({ type: 'person', slug: 'vivian' })).toBe('Vivian');
  });

  it('prettifies a hyphenated person slug', () => {
    expect(refLabel({ type: 'person', slug: 'john-doe' })).toBe('John Doe');
  });

  it('prettifies an underscored person slug', () => {
    expect(refLabel({ type: 'person', slug: 'jane_doe' })).toBe('Jane Doe');
  });

  it('returns the basename for a top-level file', () => {
    expect(refLabel({ type: 'file', path: 'THREADS.md' })).toBe('THREADS.md');
  });

  it('returns the basename for a nested file path', () => {
    expect(refLabel({ type: 'file', path: 'Journal/Daily/2026-07-07.md' })).toBe('2026-07-07.md');
  });
});
