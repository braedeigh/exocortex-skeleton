/**
 * parkedReading.ts — pure logic for the reading room's third scroll clause:
 * PARKED READING (her 07-23 ask, thought up in the car). She's read to the
 * bottom and left the phone in a mount — after a dwell, the page starts
 * turning its own pages so the reply keeps arriving without her hand:
 *
 * - ARM: only while a turn is writing, and only after she's been at the
 *   bottom for the full dwell (being at the bottom is the signal "I've read
 *   everything and I'm waiting"). Content growing below her doesn't break
 *   the dwell — she hasn't moved; the page has.
 * - FLIP: once a full screen of unread text has accumulated past her
 *   frontier (the bottom edge of what she's seen), scroll the frontier to
 *   the top — a page turn, not a crawl: text holds still while she reads,
 *   then advances a whole screen. Flips are paced so a fast stream can't
 *   outrun her eyes.
 * - SETTLE: when the turn ends with less than a screen left, reveal the
 *   tail and stand down.
 *
 * Her hand always outranks the machine: any wheel/touch disarms instantly
 * (the component wires that; this module just decides flips).
 */

/** How long she must sit at the bottom before the page takes over. */
export const PARK_DWELL_MS = 30_000;
/** Minimum time between page turns — a screenful of reading time. */
export const PARK_FLIP_MS = 15_000;
/** "At the bottom" tolerance, px. */
export const PARK_BOTTOM_PX = 48;

export interface ParkView {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isAtBottom(v: ParkView): boolean {
  return v.scrollHeight - v.scrollTop - v.clientHeight < PARK_BOTTOM_PX;
}

/** Ready to take over? Only while writing, only after the full dwell. */
export function shouldArm(atBottomSince: number | null, writing: boolean, now: number): boolean {
  return writing && atBottomSince !== null && now - atBottomSince >= PARK_DWELL_MS;
}

export type ParkAction =
  /** Turn the page: scroll `to`, and the frontier advances a screen. */
  | { kind: 'flip'; to: number; frontier: number }
  /** The turn is over and a partial screen remains — show it, stand down. */
  | { kind: 'reveal'; to: number }
  /** The turn is over and everything's been shown — stand down. */
  | { kind: 'disarm' }
  | { kind: 'wait' };

export function parkStep(
  v: ParkView,
  frontier: number,
  lastFlip: number,
  writing: boolean,
  now: number,
): ParkAction {
  const backlog = v.scrollHeight - frontier;
  if (backlog >= v.clientHeight) {
    if (now - lastFlip < PARK_FLIP_MS) return { kind: 'wait' };
    return { kind: 'flip', to: frontier, frontier: frontier + v.clientHeight };
  }
  if (writing) return { kind: 'wait' }; // words still coming — let them pool
  if (backlog > 0) return { kind: 'reveal', to: v.scrollHeight };
  return { kind: 'disarm' };
}
