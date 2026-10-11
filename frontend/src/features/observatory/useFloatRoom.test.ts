/**
 * useFloatRoom.test.ts — pins the room the floated questions card is given.
 *
 * The case that broke on a phone: keyboard open, page slid up behind the top
 * of the screen, about 420px visible above the message box, yet the card was
 * given ~140px and showed only its heading. The room has to come out the same
 * however the browser reports positions while the page is slid, and never
 * below the floor that keeps questions showing.
 */
import { describe, expect, it } from 'vitest';
import { floatRoomPx } from './useFloatRoom';

describe('floatRoomPx', () => {
  it('gives the floated card the space visible above the message box with the keyboard open, however positions are reported', () => {
    // A 956px-tall phone page, keyboard up: 571px of it visible, the message
    // box 151px tall at the bottom of that. iOS may report the page's edges
    // relative to the slid page or to the unslid one; shift every position by
    // the slide and the answer must not move.
    const slid = { pageTop: -385, pageBottom: 571, dockTop: 420, visibleHeight: 571 };
    const unslid = { pageTop: 0, pageBottom: 956, dockTop: 805, visibleHeight: 571 };
    expect([floatRoomPx(slid), floatRoomPx(unslid)]).toEqual([420, 420]);
  });

  it('never goes below the floor, and stops at the top of the page when the keyboard is closed', () => {
    const keyboardClosed = { pageTop: 60, pageBottom: 956, dockTop: 805, visibleHeight: 956 };
    const cramped = { pageTop: 0, pageBottom: 300, dockTop: 200, visibleHeight: 150 };
    expect([floatRoomPx(keyboardClosed), floatRoomPx(cramped)]).toEqual([745, 240]);
  });
});
