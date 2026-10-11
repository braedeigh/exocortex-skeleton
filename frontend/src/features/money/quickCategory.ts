/**
 * quickCategory.ts — guesses the category for a hand-logged expense from the
 * words she types ("coffee" → Eating Out), so the "Log expense" card fills the
 * category in for her.
 *
 * It learns from her own history: every past expense whose name or bank text
 * has a word starting with what she typed votes for its category, and the
 * category with the most votes wins (the newest breaks a tie). Typing a
 * category's own name ("groceries") picks that category. Only categories the
 * form can offer are ever suggested. Used by QuickExpense.tsx.
 * Prompt: "auto fill expense type on each expense entry" — e.g. "coffee" or
 * "drinks".
 */
import type { Expense } from './types';

export interface CategoryGuess {
  category: string;
  /** How many past expenses agreed; 0 when it matched a category's name. */
  votes: number;
}

export function suggestCategory(text: string, history: Expense[], offered: string[]): CategoryGuess | null {
  const typed = text.trim().toLowerCase();
  if (typed.length < 2 || offered.length === 0) return null;

  // Typing a category's own name picks it.
  const named = offered.find((c) => startsAWord(c.toLowerCase(), typed));
  if (named) return { category: named, votes: 0 };

  // Past expenses vote: the whole phrase first, then each longer word on its
  // own, longest first, so "iced coffee" still finds the coffee shops.
  const words = typed.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  for (const phrase of [typed, ...words]) {
    const guess = vote(phrase, history, offered);
    if (guess) return guess;
  }
  return null;
}

/** Tally the categories of past expenses that mention `phrase`. */
function vote(phrase: string, history: Expense[], offered: string[]): CategoryGuess | null {
  const offeredByLower = new Map(offered.map((c) => [c.toLowerCase(), c]));
  const tally = new Map<string, { votes: number; newest: string }>();
  for (const e of history) {
    const category = offeredByLower.get((e.category || '').toLowerCase());
    if (!category) continue;
    const said = `${e.title || ''} ${e.comments || ''}`.toLowerCase();
    if (!startsAWord(said, phrase)) continue;
    const entry = tally.get(category) || { votes: 0, newest: '' };
    entry.votes += 1;
    if ((e.date || '') > entry.newest) entry.newest = e.date || '';
    tally.set(category, entry);
  }
  let best: CategoryGuess | null = null;
  let bestNewest = '';
  for (const [category, { votes, newest }] of tally) {
    if (!best || votes > best.votes || (votes === best.votes && newest > bestNewest)) {
      best = { category, votes };
      bestNewest = newest;
    }
  }
  return best;
}

/** Does some word in `haystack` start with `phrase`? ("cosmic coffee" / "cof" → yes) */
function startsAWord(haystack: string, phrase: string): boolean {
  let at = haystack.indexOf(phrase);
  while (at !== -1) {
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1])) return true;
    at = haystack.indexOf(phrase, at + 1);
  }
  return false;
}
