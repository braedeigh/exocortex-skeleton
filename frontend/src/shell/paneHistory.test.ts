import { describe, expect, it } from 'vitest';
import { fillPending, popLocation, pushLocation, type PaneLocation } from './paneHistory';

/**
 * paneHistory.test.ts — the left pane's location stack, tested as plain
 * functions with no DOM and no React.
 *
 * What's worth testing here is the stuff that breaks quietly: pushing the
 * place you're already standing (which would leave a ‹ that appears to do
 * nothing), the fetched default overwriting a conversation something else
 * already chose, and the depth cap eating the floor. None of that shows up as
 * an error — it shows up as the back button behaving oddly a week later.
 *
 * Same shape as the rest of the frontend suite (`npm test`): a pure helper
 * module gets a .test.ts beside it, named for the behaviour, one assertion of
 * intent each — see calendarMath.test.ts or undoStack.test.ts.
 */

const start: PaneLocation[] = [{ roster: true, conv: 'a' }];

describe('pushLocation', () => {
  it('keeps the fields you leave out', () => {
    expect(pushLocation(start, { roster: false })).toEqual([
      { roster: true, conv: 'a' },
      { roster: false, conv: 'a' },
    ]);
  });

  it('returns the same array when you push where you already are', () => {
    // Identity, not just equality — this is what stops a re-render.
    expect(pushLocation(start, { roster: true, conv: 'a' })).toBe(start);
  });

  it('treats a different conversation in the same view as a new place', () => {
    const moved = pushLocation(start, { roster: false, conv: 'b' });
    expect(pushLocation(moved, { conv: 'c' })).toHaveLength(3);
  });

  it('distinguishes an explicit null conversation from an omitted one', () => {
    // null means "compose fresh" — a real destination, not "unchanged".
    expect(pushLocation(start, { conv: null })).toHaveLength(2);
    expect(pushLocation(start, {})).toBe(start);
  });

  it('drops the oldest entries past the cap rather than growing forever', () => {
    let stack = start;
    for (let i = 0; i < 60; i++) stack = pushLocation(stack, { conv: `c${i}` });
    expect(stack).toHaveLength(30);
    expect(stack[stack.length - 1].conv).toBe('c59');
  });
});

describe('popLocation', () => {
  it('steps back one', () => {
    const stack = pushLocation(start, { roster: false, conv: 'b' });
    expect(popLocation(stack)).toEqual(start);
  });

  it('refuses to pop the last entry — the pane is always somewhere', () => {
    expect(popLocation(start)).toBe(start);
  });
});

describe('fillPending', () => {
  it('completes the entries that never got a conversation', () => {
    const stack: PaneLocation[] = [{ roster: true, conv: undefined }];
    expect(fillPending(stack, 'keeper-1')).toEqual([{ roster: true, conv: 'keeper-1' }]);
  });

  it('leaves a conversation something already chose alone', () => {
    // The race this guards: the terrain map pushes a session while the
    // opening-conversation fetch is still in flight. The push wins.
    const stack: PaneLocation[] = [
      { roster: true, conv: undefined },
      { roster: false, conv: 'from-the-map' },
    ];
    expect(fillPending(stack, 'keeper-1')).toEqual([
      { roster: true, conv: 'keeper-1' },
      { roster: false, conv: 'from-the-map' },
    ]);
  });

  it('resolves to null when there are no sessions, and stops being pending', () => {
    const resolved = fillPending([{ roster: true, conv: undefined }], null);
    expect(resolved[0].conv).toBeNull();
    expect(fillPending(resolved, 'late')).toBe(resolved);
  });
});
