import { describe, expect, it } from 'vitest';
import { formatNoteAge, isLongNote, sortNotesByCreated } from './noteHelpers';

describe('formatNoteAge', () => {
  const now = new Date('2026-07-08T15:00:00');

  it('returns empty string for empty/missing created', () => {
    expect(formatNoteAge('', now)).toBe('');
    expect(formatNoteAge('   ', now)).toBe('');
  });

  it('returns empty string for unparseable input', () => {
    expect(formatNoteAge('not a date', now)).toBe('');
  });

  it('shows "now" for the same minute', () => {
    expect(formatNoteAge('2026-07-08 15:00', now)).toBe('now');
  });

  it('shows minutes under an hour', () => {
    expect(formatNoteAge('2026-07-08 14:40', now)).toBe('20m');
  });

  it('shows hours under a day', () => {
    expect(formatNoteAge('2026-07-08 12:00', now)).toBe('3h');
  });

  it('shows days under two weeks', () => {
    expect(formatNoteAge('2026-07-05 15:00', now)).toBe('3d');
    expect(formatNoteAge('2026-06-25 15:00', now)).toBe('13d');
  });

  it('falls back to a short date past two weeks', () => {
    expect(formatNoteAge('2026-06-01 09:30', now)).toBe('jun 1');
    expect(formatNoteAge('2025-12-25 09:30', now)).toBe('dec 25');
  });
});

describe('isLongNote', () => {
  it('is false for short single-line text', () => {
    expect(isLongNote('a quick note')).toBe(false);
  });

  it('is true past the character threshold', () => {
    expect(isLongNote('x'.repeat(181))).toBe(true);
  });

  it('is true past the line threshold even if short', () => {
    expect(isLongNote('a\nb\nc\nd')).toBe(true);
  });

  it('is false at exactly the boundary', () => {
    expect(isLongNote('x'.repeat(180))).toBe(false);
    expect(isLongNote('a\nb\nc')).toBe(false);
  });
});

describe('sortNotesByCreated', () => {
  function note(id: string, created: string) {
    return { id, created };
  }

  it('sorts newest first', () => {
    const notes = [note('a', '2026-07-01 10:00'), note('b', '2026-07-08 10:00'), note('c', '2026-07-05 10:00')];
    expect(sortNotesByCreated(notes, 'newest').map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts oldest first', () => {
    const notes = [note('a', '2026-07-01 10:00'), note('b', '2026-07-08 10:00'), note('c', '2026-07-05 10:00')];
    expect(sortNotesByCreated(notes, 'oldest').map((n) => n.id)).toEqual(['a', 'c', 'b']);
  });

  it('sends empty/missing created to the end regardless of direction', () => {
    const notes = [note('a', ''), note('b', '2026-07-08 10:00'), note('c', '2026-07-05 10:00')];
    expect(sortNotesByCreated(notes, 'newest').map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(sortNotesByCreated(notes, 'oldest').map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const notes = [note('a', '2026-07-01 10:00'), note('b', '2026-07-08 10:00')];
    const copy = [...notes];
    sortNotesByCreated(notes, 'newest');
    expect(notes).toEqual(copy);
  });
});
