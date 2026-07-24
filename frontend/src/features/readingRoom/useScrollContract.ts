import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { PARK_BOTTOM_PX, parkStep, shouldArm } from './parkedReading';
import type { Turn } from './events';

/**
 * useScrollContract.ts — the reading room's entire scroll contract (bot-
 * surface-design §5, Sunflower spec 07-23): FOLLOW-THEN-LOCK on send, the
 * bottom-pin on open, the ↓ latest pill, and the third clause, PARKED
 * READING (her 07-23 ask, from the car). See ReadingRoomPage.tsx's own doc
 * comment for the full narrative — this hook owns the mechanism.
 */
export function useScrollContract(args: {
  turns: Turn[];
  shownChars: number;
  streaming: boolean;
  writing: boolean;
}): {
  scrollRef: RefObject<HTMLDivElement | null>;
  columnRef: RefObject<HTMLDivElement | null>;
  showJump: boolean;
  parkArmed: boolean;
  jumpToLatest: () => void;
  jumpTo: (edge: 'top' | 'bottom') => void;
  disarmPark: () => void;
  beginFollow: (anchorIndex: number) => void;
  pinToBottom: () => void;
} {
  const { turns, shownChars, streaming, writing } = args;

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // Follow-then-lock state: following is on from send until her message hits
  // the viewport top (lock) or she scrolls herself (cancel).
  const followRef = useRef(false);
  const anchorIndexRef = useRef<number | null>(null);
  // Parked reading (see parkedReading.ts): armed state renders the little
  // "turning pages" note; the working parts live in refs because the ticker
  // reads them between renders.
  const [parkArmed, setParkArmed] = useState(false);
  const parkedRef = useRef(false);
  const frontierRef = useRef<number | null>(null);
  const lastFlipRef = useRef(0);
  // When she last ARRIVED at the bottom. Content growing below her doesn't
  // clear it (no scroll event fires for growth) — only her own hand does.
  const atBottomSinceRef = useRef<number | null>(null);
  // Bottom-pin on open: a conversation always opens anchored to its latest
  // output, and STAYS anchored through late layout shifts (markdown, fonts,
  // code blocks growing the page after the first snap) — until her first
  // scroll, or a send (follow-then-lock takes over from there).
  const pinBottomRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  // The park ticker reads writingRef between renders — mirrored from the
  // `writing` arg exactly as the page used to mirror it locally.
  const writingRef = useRef(writing);
  writingRef.current = writing;

  // Standing down the parked reader: her hand, a jump, or a new send.
  const disarmPark = useCallback(() => {
    parkedRef.current = false;
    frontierRef.current = null;
    atBottomSinceRef.current = null;
    setParkArmed(false);
  }, []);

  // Land at the latest turn, always — like reopening a terminal. The
  // pin (see the ResizeObserver below) keeps us there while the
  // rendered markdown finishes laying out.
  const pinToBottom = useCallback(() => {
    pinBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && pinBottomRef.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Her hand outranks the machine: any manual scroll input cancels the
  // send-follow, the open-at-bottom pin, AND the parked reader.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cancel = () => {
      followRef.current = false;
      pinBottomRef.current = false;
      disarmPark();
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchmove', cancel, { passive: true });
    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchmove', cancel);
    };
  }, [disarmPark]);

  // The pin itself: while pinned, any growth of the content column re-snaps
  // the viewport to the bottom — this is what makes "opens at the bottom"
  // survive markdown/code blocks finishing their layout after the load snap.
  useEffect(() => {
    const el = scrollRef.current;
    const col = columnRef.current;
    if (!el || !col || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  // The follow step, after each streamed update paints: keep the live tail
  // in view until the anchor (her sent message) reaches the viewport top —
  // then clamp there and stop for good.
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchor =
      anchorIndexRef.current !== null
        ? el.querySelector(`[data-turn="${anchorIndexRef.current}"]`)
        : null;
    const bottom = el.scrollHeight - el.clientHeight;
    if (anchor instanceof HTMLElement && anchor.offsetTop <= bottom) {
      // Locking scroll position: her message at the top, done following.
      el.scrollTop = anchor.offsetTop - 8;
      followRef.current = false;
    } else {
      el.scrollTop = bottom;
    }
    // shownChars: with the word flow, the page grows on paced releases, not
    // just on turns changes — the follow has to track those too.
  }, [turns, shownChars]);

  useEffect(() => {
    if (!streaming) followRef.current = false;
  }, [streaming]);

  // The ↓ latest pill: visible only while writing AND the live tail is out
  // of view. Scroll position is never touched here — display only.
  const updateJump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(fromBottom > 200);
    // Arriving at the bottom starts the parked-reading dwell clock. Never
    // cleared here: content growing below her isn't her leaving (growth
    // fires no scroll event anyway) — only her hand clears it (disarmPark).
    if (fromBottom < PARK_BOTTOM_PX && atBottomSinceRef.current === null) {
      atBottomSinceRef.current = Date.now();
    }
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateJump, { passive: true });
    return () => el.removeEventListener('scroll', updateJump);
  }, [updateJump]);
  useEffect(() => {
    if (streaming) updateJump();
    else setShowJump(false);
  }, [streaming, turns, updateJump]);

  const jumpToLatest = () => {
    disarmPark(); // landing at the bottom restarts the dwell from scratch
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const jumpTo = (edge: 'top' | 'bottom') => {
    followRef.current = false; // an explicit jump outranks any follow or pin
    pinBottomRef.current = false;
    disarmPark();
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' });
  };

  // No jump — start following: the reply prints below her message and the
  // page tracks it until that message reaches the top (the lock), or she
  // scrolls (the cancel). See the follow effect above. The open-at-bottom
  // pin hands off to the follow here.
  const beginFollow = useCallback(
    (anchorIndex: number) => {
      pinBottomRef.current = false;
      anchorIndexRef.current = anchorIndex;
      followRef.current = true;
      // A new turn starts the scroll contract over; the follow phase's trips
      // through the bottom will re-seed the parked reader's dwell clock.
      disarmPark();
    },
    [disarmPark],
  );

  // The parked reader's ticker: 1s of granularity is plenty for arming
  // (30s dwell) and page turns (15s pacing). Runs while a turn is writing
  // (to arm) and while armed (to drain a backlog after the turn ends).
  useEffect(() => {
    if (!writing && !parkArmed) return;
    const id = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const now = Date.now();
      if (!parkedRef.current) {
        // Pre-lock the follow already tracks the tail — nothing to park.
        if (followRef.current) return;
        if (shouldArm(atBottomSinceRef.current, writingRef.current, now)) {
          parkedRef.current = true;
          setParkArmed(true);
          // The open-at-bottom pin snaps to the tail on every growth — the
          // parked reader takes over from it (stable pages, not a crawl).
          pinBottomRef.current = false;
          // Her frontier: the bottom edge of what she's seen. The viewport
          // bottom, not the content bottom — the reply may already have
          // grown past her while she dwelled.
          frontierRef.current = el.scrollTop + el.clientHeight;
          lastFlipRef.current = 0; // the dwell was the wait; first turn owes none
        }
        return;
      }
      const frontier = frontierRef.current ?? el.scrollTop + el.clientHeight;
      const act = parkStep(
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        frontier,
        lastFlipRef.current,
        writingRef.current,
        now,
      );
      if (act.kind === 'flip') {
        el.scrollTo({ top: act.to, behavior: 'smooth' });
        frontierRef.current = act.frontier;
        lastFlipRef.current = now;
      } else if (act.kind === 'reveal' || act.kind === 'disarm') {
        if (act.kind === 'reveal') el.scrollTo({ top: act.to, behavior: 'smooth' });
        parkedRef.current = false;
        frontierRef.current = null;
        setParkArmed(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [writing, parkArmed]);

  return {
    scrollRef,
    columnRef,
    showJump,
    parkArmed,
    jumpToLatest,
    jumpTo,
    disarmPark,
    beginFollow,
    pinToBottom,
  };
}
