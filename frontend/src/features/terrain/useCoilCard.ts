/**
 * useCoilCard.ts — when the coil card (CoilHoverCard.tsx) is up, and where.
 *
 * The agent card's timing (TerrainPage's onHoverAgent), for a coil's centre:
 * up after the mouse rests a moment, down after a short grace once it leaves,
 * and the cursor arriving IN the card cancels the grace so the card can be
 * reached across the gap. A finger can't hover, so a tap opens the card
 * PINNED — it stays until closed, and the mouse's comings and goings leave it
 * alone.
 *
 * Used by TerrainPage.tsx, which hands `hover` to the engine as onHoverCoil.
 */
import { useEffect, useRef, useState } from 'react';
import type { Anchor } from './agentHoverPlacement';

/** How long the mouse rests on a centre before the card comes up, and how
 * long it lingers after the mouse leaves — the agent card's numbers. */
const SHOW_DELAY_MS = 180;
const LEAVE_GRACE_MS = 240;

export interface CoilCardState {
  folderId: string;
  anchor: Anchor;
  /** Opened by a finger: stays until closed, and offers Collapse. */
  pinned: boolean;
}

/**
 * The card's show/hide timing, kept out of TerrainPage. `hover` is the
 * engine's report (mouse only); `open` is a finger's tap; `engage` is the
 * cursor arriving in or leaving the card; `close` is the × or a tap elsewhere.
 */
export function useCoilCard() {
  const [card, setCard] = useState<CoilCardState | null>(null);
  const showTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const engaged = useRef(false);
  const shown = useRef(false);
  // Held in a ref as well as in `card`: the engine keeps whichever `hover` it
  // was handed last, so the answer has to be current even from an old one.
  const pinned = useRef(false);

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    showTimer.current = null;
    leaveTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const close = () => {
    clearTimers();
    engaged.current = false;
    shown.current = false;
    pinned.current = false;
    setCard(null);
  };

  // Leave with a grace period, so the cursor can cross the gap into the card.
  const leaveSoon = () => {
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      if (!engaged.current) close();
    }, LEAVE_GRACE_MS);
  };

  const hover = (next: { folderId: string } & Anchor | null, hard?: boolean) => {
    // A card a finger opened isn't the mouse's to take down.
    if (pinned.current) return;
    clearTimers();
    if (next === null) {
      if (hard) close();
      else if (!engaged.current) leaveSoon();
      return;
    }
    const state = { folderId: next.folderId, anchor: next, pinned: false };
    if (shown.current) {
      setCard(state);
      return;
    }
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      shown.current = true;
      setCard(state);
    }, SHOW_DELAY_MS);
  };

  const open = (folderId: string, anchor: Anchor) => {
    clearTimers();
    shown.current = true;
    pinned.current = true;
    setCard({ folderId, anchor, pinned: true });
  };

  const engage = (inside: boolean) => {
    engaged.current = inside;
    if (inside) clearTimers();
    else if (!pinned.current) leaveSoon();
  };

  return { card, hover, open, engage, close };
}

