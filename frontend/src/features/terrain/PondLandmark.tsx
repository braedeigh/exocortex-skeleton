import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePondShape } from '../pond/api';
import { bucketShape, shapePath } from '../pond/pondShape';
import { describeSavedView, loadPondView, POND_VIEW_KEY } from '../pond/savedView';
import type { PondAnchor } from './terrainCanvas';
import styles from './PondLandmark.module.css';

/**
 * PondLandmark — the pond, floating small over the part of the terrain that IS
 * the journal.
 *
 * The map already draws the journal: the card pool and the diary are real
 * files in the vault, around two thousand of them, so the biggest single
 * cluster on the terrain is her own writing. It just draws them as anonymous
 * dots. This puts a little pond over that cluster and says what it is.
 *
 * THREE SIZES, one object:
 *
 *   RESTING   small and deliberately crude — twelve buckets, a blurred blob of
 *             water. It's a landmark, not a chart; at this size it should read
 *             as "there's a pond over there" and nothing more.
 *   REACHED   hover, focus, or a first tap: it eases up to full size, the
 *             silhouette resolves to fifty buckets, the filter display appears,
 *             and the water under the real dots lights on the canvas so she can
 *             see WHICH part of the map this is a picture of.
 *   ENTERED   a click on a reached landmark goes to /terrain/pond.
 *
 * Anchored in WORLD position, drawn at SCREEN-LOCKED size: the engine reports
 * where the journal cluster is sitting (onPondMove) and this follows it through
 * every pan and zoom, but never shrinks with it. That's how map labels work,
 * and it's what keeps the type legible at every zoom — the house floor is 12px
 * and a canvas-drawn label would break it constantly.
 *
 * THE FILTER DISPLAY is the other half of the ask: the pond already remembered
 * its own settings across visits, so stepping back out of it lands on the map
 * with those filters still set — and the landmark wears them, so what the pond
 * is currently showing is readable without going in. A pond at its defaults
 * says nothing (see describeSavedView); chips only appear for something she
 * chose.
 *
 * Reads GET /api/pond/shape for the silhouette and localStorage for the
 * filters. Shape maths in ../pond/pondShape.ts, filter wording in
 * ../pond/savedView.ts — both tested.
 *
 * Prompt that produced it: "i basically want the pond to be floating over the
 * terrain dots map in the area where all the journal entries are" / "i want it
 * to be small and poorly detailed and if you hover over it it gets big and then
 * you can click on it to enter it" / "and you can come back out of it with the
 * filters you set... so its floating with the filter display".
 */

/** How many buckets each size draws. The gap between them IS the level of
 * detail — same data, same path function, different resolution. */
const CRUDE_COLUMNS = 12;
const RESOLVED_COLUMNS = 50;

/** The drawing box at each size, in CSS px. Resting is small enough to read as
 * a map symbol; reached is big enough for the silhouette to be worth looking
 * at and for the chips to sit at a comfortable size. */
const RESTING = { w: 76, h: 46 };
const REACHED = { w: 300, h: 150 };

export function PondLandmark({
  anchor,
  onReach,
}: {
  /** Where the journal cluster is on screen, from the canvas engine. */
  anchor: PondAnchor | null;
  /** Tell the map she's looking at it, so it can light the water underneath. */
  onReach: (reached: boolean) => void;
}) {
  const navigate = useNavigate();
  const [reached, setReached] = useState(false);
  const shape = usePondShape(anchor !== null);
  // Re-read the filters whenever she arrives back on the map — she may have
  // just come out of the pond having changed them. `storage` alone isn't
  // enough: it only fires for OTHER tabs, so the common case (same tab, in and
  // back out) would never update.
  const [savedTick, setSavedTick] = useState(0);
  useEffect(() => {
    const bump = () => setSavedTick((n) => n + 1);
    window.addEventListener('focus', bump);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === POND_VIEW_KEY) bump();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', bump);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const facets = useMemo(() => describeSavedView(loadPondView()), [savedTick]);

  const box = reached ? REACHED : RESTING;
  const columns = useMemo(() => {
    const days = shape.data?.days ?? [];
    return bucketShape(days, reached ? RESOLVED_COLUMNS : CRUDE_COLUMNS);
  }, [shape.data?.days, reached]);
  const path = useMemo(() => shapePath(columns, box.w, box.h), [columns, box.w, box.h]);

  // Her share of the pond, for the tint — a pond that's mostly Keeper reads a
  // touch cooler than one that's mostly her own voice.
  const ownShare = useMemo(() => {
    if (columns.length === 0) return 0.5;
    const total = columns.reduce((s, c) => s + c.cards, 0);
    if (total === 0) return 0.5;
    return columns.reduce((s, c) => s + c.ownShare * c.cards, 0) / total;
  }, [columns]);

  const reach = (next: boolean) => {
    setReached(next);
    onReach(next);
  };

  // A pointer that isn't a mouse gets no hover — the first tap reaches, the
  // second enters (see onClick). Without this a phone would be stuck in
  // whatever state one tap left it in, with no way to leave.
  const isMouse = useRef(true);

  const enter = () => {
    reach(false);
    void navigate({ to: '/terrain/pond' });
  };

  if (!anchor) return null;

  // Kept clear of the viewport edges so a pond near the rim doesn't get cut
  // off — the landmark is chrome, and chrome shouldn't need panning to read.
  const half = { w: box.w / 2, h: box.h / 2 };
  const margin = 12;
  const left = Math.max(
    half.w + margin,
    Math.min(anchor.x, window.innerWidth - half.w - margin),
  );
  const top = Math.max(
    half.h + margin,
    Math.min(anchor.y, window.innerHeight - half.h - margin - (reached ? 56 : 20)),
  );

  const empty = shape.data !== undefined && columns.length === 0;

  return (
    <button
      type="button"
      className={[styles.landmark, reached ? styles.reached : ''].filter(Boolean).join(' ')}
      style={{ left, top, width: box.w, height: box.h }}
      aria-label={
        reached
          ? `Open the pond — ${shape.data?.cards.toLocaleString() ?? ''} cards`
          : 'The pond — your journal. Open it.'
      }
      aria-expanded={reached}
      onPointerEnter={(e) => {
        isMouse.current = e.pointerType === 'mouse';
        if (e.pointerType === 'mouse') reach(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') reach(false);
      }}
      onPointerDown={(e) => {
        isMouse.current = e.pointerType === 'mouse';
      }}
      onFocus={() => reach(true)}
      onBlur={() => reach(false)}
      onClick={() => {
        // One rule covers both pointers: a click on a landmark she's already
        // reached enters it, a click on a resting one reaches it. A mouse
        // never notices the two steps, because hovering already did the first.
        if (reached) enter();
        else reach(true);
      }}
    >
      {/* The water. One filled body rather than bars — at 76px a bar chart is
          an unreadable smear, but a blob still reads as a pond, which is
          exactly what "poorly detailed" should look like. */}
      <svg
        className={styles.water}
        width={box.w}
        height={box.h}
        viewBox={`0 0 ${box.w} ${box.h}`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pond-surface" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pond-bright)" stopOpacity={0.85} />
            <stop offset="100%" stopColor="var(--pond-deep)" stopOpacity={0.55} />
          </linearGradient>
        </defs>
        {path ? (
          <>
            <path d={path} fill="url(#pond-surface)" />
            {/* The surface line, a shade brighter than the body — this is what
                makes it read as water with a top rather than as a filled
                area chart. */}
            <path d={path} className={styles.surface} fill="none" />
          </>
        ) : null}
      </svg>

      {/* The name, and — once she's close enough for it to be worth saying —
          how much is in there. */}
      <span className={styles.name}>
        <span className={styles.nameText}>Pond</span>
        {reached && shape.data ? (
          <span className={styles.count}>{shape.data.cards.toLocaleString()} cards</span>
        ) : null}
      </span>

      {empty ? <span className={styles.note}>nothing in the pool yet</span> : null}

      {/* THE FILTER DISPLAY. At rest only the lit thread shows, and only as a
          single quiet chip: the landmark is small, and one word saying what
          the pond is currently about is worth more there than a row of
          settings. Reached, it says everything she set. */}
      {facets.length > 0 ? (
        <span className={styles.filters}>
          {(reached ? facets : facets.filter((f) => f.kind === 'lit')).map((f) => (
            <span
              key={`${f.kind}:${f.label}`}
              className={f.kind === 'lit' ? styles.chipLit : styles.chip}
            >
              {f.label}
            </span>
          ))}
        </span>
      ) : null}

      {/* The way in, spelled out once she's reached it. A mouse user can click
          anywhere on the landmark; this is here so the gesture is VISIBLE, and
          so a touch user has an unambiguous ~40px target for the second tap. */}
      {reached ? <span className={styles.enter}>Open the pond →</span> : null}

      {/* Her voice against the Keeper's, as a hairline under the water. The
          one fact about the pond's contents that fits at this size. */}
      {reached ? (
        <span className={styles.ownBar} aria-hidden="true">
          <span className={styles.ownFill} style={{ width: `${Math.round(ownShare * 100)}%` }} />
        </span>
      ) : null}
    </button>
  );
}
