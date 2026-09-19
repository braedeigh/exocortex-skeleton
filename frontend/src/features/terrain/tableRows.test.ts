import { describe, expect, it } from 'vitest';
import { splitOnMatch } from './tableRows';

/** tableRows.test.ts — the highlight arithmetic behind the rows view's search. */
describe('splitOnMatch', () => {
  it('marks every place the word appears, whatever its case', () => {
    expect(splitOnMatch('Todo and todo_fronts', 'todo')).toEqual([
      { text: 'Todo', match: true },
      { text: ' and ', match: false },
      { text: 'todo', match: true },
      { text: '_fronts', match: false },
    ]);
  });

  it('gives the text back whole when there is no word or no match', () => {
    expect(splitOnMatch('habits', '')).toEqual([{ text: 'habits', match: false }]);
    expect(splitOnMatch('habits', 'xyz')).toEqual([{ text: 'habits', match: false }]);
  });

  it('looks for the word as typed, never as a pattern', () => {
    expect(splitOnMatch('a.c abc', 'a.c')).toEqual([
      { text: 'a.c', match: true },
      { text: ' abc', match: false },
    ]);
  });
});
