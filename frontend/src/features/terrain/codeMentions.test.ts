import { describe, expect, it } from 'vitest';
import { mentionsFromSearch, mentionsToSearch, stepMention } from './codeMentions';

/**
 * codeMentions.test.ts — that "open this file where it names that" survives
 * the round trip through a URL, that a malformed param can't take the page
 * down with it, and that the arrows go round rather than into a wall.
 */

describe('the mentions search params', () => {
  it('round-trips a table and its lines', () => {
    const search = mentionsToSearch({ label: 'todos', lines: [4, 9, 30] });
    expect(search).toEqual({ mentions: '4,9,30', of: 'todos' });
    expect(mentionsFromSearch(search.mentions, search.of)).toEqual({
      label: 'todos',
      lines: [4, 9, 30],
    });
  });

  it('carries nothing when there is nothing to carry', () => {
    expect(mentionsToSearch(undefined)).toEqual({});
    expect(mentionsToSearch({ label: 'todos', lines: [] })).toEqual({});
  });

  it('reads a malformed list as no mentions rather than crashing', () => {
    expect(mentionsFromSearch('4,not-a-line', 'todos')).toBeUndefined();
    expect(mentionsFromSearch('', 'todos')).toBeUndefined();
    expect(mentionsFromSearch(undefined, 'todos')).toBeUndefined();
  });

  it('keeps the lines when the label was lost', () => {
    expect(mentionsFromSearch('4,9')).toEqual({ label: '', lines: [4, 9] });
  });
});

describe('stepMention', () => {
  it('walks forward and back', () => {
    expect(stepMention(0, 1, 3)).toBe(1);
    expect(stepMention(2, -1, 3)).toBe(1);
  });

  it('wraps at both ends', () => {
    expect(stepMention(2, 1, 3)).toBe(0);
    expect(stepMention(0, -1, 3)).toBe(2);
  });

  it('clamps an index left over from a longer list', () => {
    expect(stepMention(9, 1, 3)).toBe(0);
  });

  it('has nowhere to go with no mentions', () => {
    expect(stepMention(0, 1, 0)).toBe(0);
  });
});
