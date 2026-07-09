/** Pure logic for the Food experiments card — port of kitchen.js
 * renderFoodExperiments + routes/food_test.py's state machine. */
import type { FoodTest } from './types';

export type ExperimentPhase = 'testing' | 'recovering' | 'clear';

export interface ExperimentState {
  phase: ExperimentPhase;
  /** The unresolved test, when phase === 'testing'. */
  active: FoodTest | null;
  /** Most recent flared-not-yet-baseline-cleared test, when phase === 'recovering'. */
  recovering: FoodTest | null;
  /** Resolved tests, newest first. */
  past: FoodTest[];
}

export function deriveExperimentState(tests: FoodTest[] | undefined): ExperimentState {
  const list = tests || [];
  const active = list.find((t) => !t.outcome) || null;
  const recovering = active
    ? null
    : [...list].reverse().find((t) => t.outcome === 'flared' && !t.cleared_baseline_on) || null;
  const phase: ExperimentPhase = active ? 'testing' : recovering ? 'recovering' : 'clear';
  const past = list.filter((t) => t.outcome).slice().reverse();
  return { phase, active, recovering, past };
}

/** Day N of the watch window (day 1 = start day) — port of the dayN math,
 * with dates compared as UTC midnights so DST can't skew the count. */
export function testDayNumber(startedOn: string, today: string): number {
  const start = Date.parse(startedOn + 'T00:00:00Z');
  const now = Date.parse(today + 'T00:00:00Z');
  if (Number.isNaN(start) || Number.isNaN(now)) return 1;
  return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}

/** "Mark cleared" only unlocks once the watch window has fully elapsed. */
export function canResolveClear(test: FoodTest, today: string): boolean {
  return testDayNumber(test.started_on, today) >= test.watch_window_days;
}

/**
 * Move `food` by delta within the queue (case-insensitive match, like the
 * old _foodTestQueueMove). Returns null when the move is a no-op (not found
 * or already at the edge).
 */
export function moveInQueue(queue: string[], food: string, delta: number): string[] | null {
  const idx = queue.findIndex((f) => f.toLowerCase() === food.toLowerCase());
  if (idx === -1) return null;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= queue.length) return null;
  const next = queue.slice();
  const [moved] = next.splice(idx, 1);
  next.splice(newIdx, 0, moved);
  return next;
}
