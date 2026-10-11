import { describe, expect, it } from 'vitest';
import { messageArrow } from './messageArrows';

const head = { length: 10, halfWidth: 4 };
const left = { x: 0, y: 0 };
const right = { x: 200, y: 0 };

describe('messageArrow', () => {
  it('puts the head at the end that received, its point just clear of that ring', () => {
    const arrow = messageArrow(
      { at: left, clear: 20, headed: false },
      { at: right, clear: 20, headed: true },
      head,
    )!;
    expect(arrow.headAtStart).toBeNull();
    // The point stops 20 short of the receiver and faces it; the line stops at the head's base.
    expect(arrow.headAtEnd![0]).toEqual({ x: 180, y: 0 });
    expect(arrow.headAtEnd![1].x).toBe(170);
    expect(arrow.end).toEqual({ x: 170, y: 0 });
    // The sender's end has no head, so the line runs under its ring to the centre.
    expect(arrow.start).toEqual(left);
  });

  it('gives a conversation a head at each end, pointing away from each other', () => {
    const arrow = messageArrow(
      { at: left, clear: 20, headed: true },
      { at: right, clear: 20, headed: true },
      head,
    )!;
    expect(arrow.headAtStart![0]).toEqual({ x: 20, y: 0 });
    expect(arrow.headAtEnd![0]).toEqual({ x: 180, y: 0 });
    expect(arrow.start.x).toBe(30);
    expect(arrow.end.x).toBe(170);
  });

  it('stops a headless end at the rim too when nothing covers the line there (the map)', () => {
    const arrow = messageArrow(
      { at: left, clear: 20, headed: false },
      { at: right, clear: 20, headed: true },
      head,
      true,
    )!;
    expect(arrow.start).toEqual({ x: 20, y: 0 });
  });

  it('draws nothing when the two are too close for the heads to fit', () => {
    expect(messageArrow(
      { at: left, clear: 20, headed: true },
      { at: { x: 55, y: 0 }, clear: 20, headed: true },
      head,
    )).toBeNull();
  });
});
