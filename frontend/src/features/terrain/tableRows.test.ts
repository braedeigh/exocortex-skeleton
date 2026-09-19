import { describe, expect, it } from 'vitest';
import {
  daysAgo,
  describeFilter,
  nextSort,
  splitOnMatch,
  toggleValue,
  valueIsChosen,
  withFilter,
  withoutFilter,
  type TableFilter,
} from './tableRows';

/** tableRows.test.ts — the rules of the rows view's controls: what a tap on a
 * sort button or a value does, how filters combine, and how they read. */

describe('nextSort', () => {
  it('cycles one column: ascending, descending, then back to stored order', () => {
    const up = nextSort(null, 'created');
    const down = nextSort(up, 'created');
    expect(up).toEqual({ column: 'created', descending: false });
    expect(down).toEqual({ column: 'created', descending: true });
    expect(nextSort(down, 'created')).toBeNull();
  });

  it('starts a different column at ascending', () => {
    expect(nextSort({ column: 'created', descending: true }, 'text')).toEqual({
      column: 'text',
      descending: false,
    });
  });
});

describe('toggleValue', () => {
  it('adds a value to the column, then a second, then takes one back out', () => {
    const one = toggleValue([], 'bucket', 'done');
    const two = toggleValue(one, 'bucket', 'now');
    expect(two).toEqual([{ column: 'bucket', op: 'is', values: ['done', 'now'] }]);
    expect(toggleValue(two, 'bucket', 'done')).toEqual([{ column: 'bucket', op: 'is', values: ['now'] }]);
  });

  it('removes the filter when its last value is taken out', () => {
    expect(toggleValue(toggleValue([], 'bucket', 'done'), 'bucket', 'done')).toEqual([]);
  });

  it('clears an "is empty" on the same column, which it would contradict', () => {
    const before: TableFilter[] = [{ column: 'bucket', op: 'empty' }];
    expect(toggleValue(before, 'bucket', 'done')).toEqual([{ column: 'bucket', op: 'is', values: ['done'] }]);
  });

  it('leaves other columns alone and can choose "no value"', () => {
    const before: TableFilter[] = [{ column: 'done', op: 'is', values: [1] }];
    const after = toggleValue(before, 'bucket', null);
    expect(after).toEqual([...before, { column: 'bucket', op: 'is', values: [null] }]);
    expect(valueIsChosen(after, 'bucket', null)).toBe(true);
    expect(valueIsChosen(after, 'bucket', 'done')).toBe(false);
  });
});

describe('withFilter / withoutFilter', () => {
  const from: TableFilter = { column: 'finished_on', op: 'min', value: '2026-08-01' };
  const upTo: TableFilter = { column: 'finished_on', op: 'max', value: '2026-08-31' };

  it('lets a column hold a "from" and an "up to" together', () => {
    expect(withFilter([from], upTo)).toEqual([from, upTo]);
  });

  it('replaces a filter of the same column and kind', () => {
    const later: TableFilter = { ...from, value: '2026-09-01' };
    expect(withFilter([from, upTo], later)).toEqual([upTo, later]);
  });

  it('removes one kind, or everything on the column', () => {
    expect(withoutFilter([from, upTo], 'finished_on', 'min')).toEqual([upTo]);
    expect(withoutFilter([from, upTo], 'finished_on')).toEqual([]);
  });
});

describe('describeFilter', () => {
  it('reads like a sentence', () => {
    expect(describeFilter({ column: 'bucket', op: 'is', values: ['done', 'now'] })).toBe('bucket is done or now');
    expect(describeFilter({ column: 'genre', op: 'is', values: [null] })).toBe('genre is empty');
    expect(describeFilter({ column: 'finished_on', op: 'min', value: '2026-08-01' })).toBe('finished_on from 2026-08-01');
    expect(describeFilter({ column: 'notes', op: 'not_empty' })).toBe('notes is filled in');
  });
});

describe('daysAgo', () => {
  it('counts back in local days, across a month boundary', () => {
    expect(daysAgo(7, new Date(2026, 8, 3, 23, 30))).toBe('2026-08-27');
    expect(daysAgo(0, new Date(2026, 8, 3, 0, 5))).toBe('2026-09-03');
  });
});

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
