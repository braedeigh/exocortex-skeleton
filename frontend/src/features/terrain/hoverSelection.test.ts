import { describe, expect, it } from 'vitest';
import { highlightTarget, tapStage, wiringTarget } from './hoverSelection';

/**
 * hoverSelection.test.ts — that the first click never opens anything, that
 * the second click on the same body does, that neither a hover nor a pin can
 * light a body with nothing wired to it, and that a pin survives the cursor
 * moving across its own answer.
 */

describe('tapStage', () => {
  it('picks out a body nothing is holding yet', () => {
    expect(tapStage('vault:file:data/exo.db/todos', null)).toBe('pick');
  });

  it('opens the body that is already picked out', () => {
    expect(tapStage('agent-a', 'agent-a')).toBe('open');
  });

  it('moves the pick rather than opening, on a different body', () => {
    expect(tapStage('agent-b', 'agent-a')).toBe('pick');
  });
});

describe('highlightTarget', () => {
  const wired = (id: string) => id !== 'lonely';

  it('follows the cursor over a pin', () => {
    expect(highlightTarget('hovered', 'held', wired)).toBe('hovered');
  });

  it('falls back to the pin when the cursor is over nothing', () => {
    expect(highlightTarget(null, 'held', wired)).toBe('held');
  });

  it('lights nothing when neither is set', () => {
    expect(highlightTarget(null, null, wired)).toBeNull();
  });

  it('refuses a hovered body with nothing wired to it, and keeps the pin', () => {
    expect(highlightTarget('lonely', 'held', wired)).toBe('held');
  });

  it('refuses a pinned body with nothing wired to it', () => {
    expect(highlightTarget(null, 'lonely', wired)).toBeNull();
  });
});

describe('wiringTarget', () => {
  const wired = (id: string) => id !== 'lonely';
  // The pinned table's answer: the code files at the end of its ropes.
  const inAnswer = (id: string) => id === 'table' || id === 'store.py';

  it('keeps the pin while the cursor is inside the answer it pinned', () => {
    expect(wiringTarget('store.py', 'table', wired, inAnswer)).toBe('table');
  });

  it('hands over to a hover on something outside the answer', () => {
    expect(wiringTarget('elsewhere.py', 'table', wired, inAnswer)).toBe('elsewhere.py');
  });

  it('falls back to the plain rule when nothing is pinned', () => {
    expect(wiringTarget('store.py', null, wired, inAnswer)).toBe('store.py');
  });

  it('holds the pin when the cursor is over nothing', () => {
    expect(wiringTarget(null, 'table', wired, inAnswer)).toBe('table');
  });

  it('refuses to hold a pin with nothing wired to it', () => {
    expect(wiringTarget('store.py', 'lonely', wired, inAnswer)).toBe('store.py');
  });
});
