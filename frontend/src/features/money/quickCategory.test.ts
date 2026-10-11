import { describe, expect, it } from 'vitest';
import { suggestCategory } from './quickCategory';
import type { Expense } from './types';

const offered = ['Eating Out', 'Groceries', 'Recreation'];

function exp(comments: string, category: string, date = '2026-07-01', title = ''): Expense {
  return { id: comments, amount: 5, comments, category, date, title };
}

const history = [
  exp('TST*COSMIC COFFEE - EAS 07/15 PURCHASE', 'Eating Out'),
  exp('STARBUCKS COFFEE 07/02 PURCHASE', 'Eating Out'),
  exp('H-E-B COFFEE BEANS', 'Groceries'),
  exp('drinks with friends', 'Recreation', '2026-08-01'),
];

describe('suggestCategory', () => {
  it('picks the category most past expenses with that word were filed under', () => {
    expect(suggestCategory('coffee', history, offered)).toEqual({ category: 'Eating Out', votes: 2 });
  });

  it('learns from what she logged by hand before', () => {
    expect(suggestCategory('Drinks', history, offered)?.category).toBe('Recreation');
  });

  it('matches a word start, not the middle of a word', () => {
    expect(suggestCategory('offee', history, offered)).toBeNull();
  });

  it('falls back to single words when the whole phrase is new', () => {
    expect(suggestCategory('iced coffee', history, offered)?.category).toBe('Eating Out');
  });

  it('picks a category by its own name', () => {
    expect(suggestCategory('groc', history, offered)).toEqual({ category: 'Groceries', votes: 0 });
  });

  it('never suggests a category the form does not offer', () => {
    expect(suggestCategory('coffee', [exp('coffee', 'Income')], offered)).toBeNull();
  });

  it('waits for two letters', () => {
    expect(suggestCategory('c', history, offered)).toBeNull();
  });
});
