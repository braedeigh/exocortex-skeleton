import { describe, expect, it } from 'vitest';
import {
  addDays,
  canExpandFoodLog,
  foodBadgeColor,
  foodItemsForDate,
  foodLogDates,
  joinFoods,
  removeFoodItem,
  replaceFoodItem,
  splitFoodNotes,
} from './foodLogHelpers';
import type { FoodGuide } from './types';

describe('splitFoodNotes / joinFoods', () => {
  it('splits on ; and trims blanks', () => {
    expect(splitFoodNotes(' rice; kale ;; chicken ')).toEqual(['rice', 'kale', 'chicken']);
    expect(splitFoodNotes(null)).toEqual([]);
    expect(splitFoodNotes(undefined)).toEqual([]);
  });
  it('round-trips through joinFoods', () => {
    expect(joinFoods(['rice', 'kale'])).toBe('rice; kale');
    expect(splitFoodNotes(joinFoods(['rice', 'kale']))).toEqual(['rice', 'kale']);
  });
});

describe('foodItemsForDate', () => {
  it('reads the matching day, empty when absent', () => {
    const rows = [{ date: '2026-07-08', food_notes: 'rice; kale' }];
    expect(foodItemsForDate(rows, '2026-07-08')).toEqual(['rice', 'kale']);
    expect(foodItemsForDate(rows, '2026-07-09')).toEqual([]);
    expect(foodItemsForDate(undefined, '2026-07-08')).toEqual([]);
  });
});

describe('addDays / foodLogDates', () => {
  it('does pure calendar math across month boundaries', () => {
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
  it('lists daysBack..today oldest first', () => {
    expect(foodLogDates('2026-07-09', 3, '2026-01-01')).toEqual([
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
    ]);
  });
  it('clips days before any data exists', () => {
    expect(foodLogDates('2026-07-09', 3, '2026-07-08')).toEqual(['2026-07-08', '2026-07-09']);
  });
});

describe('canExpandFoodLog', () => {
  it('true while the window has not reached the earliest data day', () => {
    expect(canExpandFoodLog(['2026-07-06', '2026-07-09'], '2026-01-01')).toBe(true);
    expect(canExpandFoodLog(['2026-07-08', '2026-07-09'], '2026-07-08')).toBe(false);
    expect(canExpandFoodLog([], '2026-01-01')).toBe(false);
  });
});

describe('foodBadgeColor', () => {
  const guide: FoodGuide = {
    safe: ['chicken', 'white rice'],
    hurts: ['soy sauce'],
    unsure: ['sunflower seeds'],
    inflammatory: [],
  };

  it('user safety tags beat the hardcoded guide', () => {
    expect(foodBadgeColor('chicken', { chicken: 'suspect' }, guide)).toBe('var(--orange)');
    expect(foodBadgeColor('chicken', { chicken: 'inflammatory' }, guide)).toBe('#c2185b');
  });
  it('guide matching is substring in either direction', () => {
    expect(foodBadgeColor('soy sauce ramen', {}, guide)).toBe('var(--red)');
    expect(foodBadgeColor('rice', {}, guide)).toBe('var(--green)'); // 'rice' ⊂ 'white rice'
    expect(foodBadgeColor('sunflower seeds', {}, guide)).toBe('var(--yellow)');
  });
  it('unmatched food gets no badge', () => {
    expect(foodBadgeColor('mystery stew', {}, guide)).toBe('');
    expect(foodBadgeColor('mystery stew', undefined, undefined)).toBe('');
  });
});

describe('replaceFoodItem / removeFoodItem', () => {
  it('replaces in place, saving blank deletes', () => {
    expect(replaceFoodItem(['rice', 'kale'], 0, 'brown rice')).toEqual(['brown rice', 'kale']);
    expect(replaceFoodItem(['rice', 'kale'], 1, '   ')).toEqual(['rice']);
  });
  it('removes by index without mutating the input', () => {
    const foods = ['rice', 'kale'];
    expect(removeFoodItem(foods, 0)).toEqual(['kale']);
    expect(foods).toEqual(['rice', 'kale']);
  });
});
