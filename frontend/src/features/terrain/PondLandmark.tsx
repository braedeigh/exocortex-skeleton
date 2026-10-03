import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePondShape } from './pond/api';
import { bucketShape } from './pond/pondShape';
import {
  JUMP_DAYS,
  PANE_ZOOMS,
  PANE_ZOOM_DEFAULT,
  layoutPane,
  paneCaption,
  type PaneJump,
  type SizedDay,
} from './pond/pondPane';
import {
  describeSavedView,
  loadPondPane,
  loadPondView,
  savePondPane,
  POND_VIEW_KEY,
} from './pond/savedView';
import { HEAT_RAMP_LIGHT, heatColor, heatRamps, readThemeInk } from './terrainCanvas';
import type { PondAnchor, ThemeInk } from './terrainCanvas';
import { hoverBridge, paneRoom, placeLabel, placePane, type PanePlacement } from './pondPlacement';
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
 * TWO STATES, one object:
 *
 *   RESTING   invisible chrome. The map now draws the pond itself — the card
 *             cluster is collapsed to one tile node the canvas paints as a
 *             month-of-days square with a real collision body (pondNodes.ts /
 *             terrainCanvas.ts) — so a second water drawing floating over it
 *             would just cover the thing it stands for. At rest this is only
 *             the name floating just above the square, the lit-thread chip,
 *             and a transparent reach target laid over the tile.
 *   REACHED   hover, focus, or a first tap: a real pane rises out of the
 *             square and opens ABOVE it (below, or over it, only when the
 *             screen has no room) — a miniature of the pond's WORDS
 *             arrangement, with the name as its header and the filter display
 *             under it — and the water under the tile lights on the canvas so
 *             she can see WHICH part of the map this is a picture of. Opening
 *             beside the tile rather than on it is what keeps that visible.
 *             The way in is the "Open the pond" button — a click on the
 *             drawing itself belongs to time now, not to navigation.
 *
 * THE PANE is the reached drawing: one small rectangle per card, as tall as
 * that card had words in it, stacked up a column per day with a gap between
 * each, filling from the bottom like water. No text — a card is a bare mark
 * whose size is how much was written and whose colour is how recent it is, on
 * the terrain's own heat ramp. It is drawn to CANVAS rather than to SVG
 * elements because a wide pane at the coarse zoom is a few thousand marks, and
 * a few thousand DOM nodes re-laid-out on every frame of a drag is the
 * difference between a pane that moves with her finger and one that stutters.
 *
 * IT IS AN APERTURE, NOT A CHART. Drag the corner and she sees MORE TIME at the
 * same mark size; pinch and the marks grow and she sees less. It never rescales
 * to fit its box. Scroll or drag pans through time, the arrows jump by the
 * selected unit, and the pane always opens at now. All the arithmetic lives in
 * ../pond/pondPane.ts, which is pure and tested; this file is gestures, chrome
 * and paint.
 *
 * Anchored in WORLD position, drawn at SCREEN-LOCKED size: the engine reports
 * where the pond tile's square is sitting (onPondMove) and this follows it
 * through every pan and zoom, but never shrinks with it. Where each piece lands
 * relative to that square is pondPlacement.ts. That's how map labels work,
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
 * Reads GET /api/pond/shape for the silhouette, the same with `?sizes=1` for
 * the pane (only once she reaches, so the map never pays for it otherwise), and
 * localStorage for the filters and the pane's own furniture.
 *
 * Prompt that produced it: "i basically want the pond to be floating over the
 * terrain dots map in the area where all the journal entries are" / "i want it
 * to be small and poorly detailed and if you hover over it it gets big and then
 * you can click on it to enter it" / "and you can come back out of it with the
 * filters you set... so its floating with the filter display" / "i want it to be
 * like a floating pane with little squares/rectangles in it like the size of the
 * amount that was written into it... you can scroll back in time or click back
 * in time or display a month or a week" / "you can resize the window and zoom in
 * by scrolling or pinching inside of it for the size of the dots to grow".
 */

/** How many buckets the whole-pond silhouette is reduced to for the
 * owner-share hairline. Crude on purpose. */
const CRUDE_COLUMNS = 12;

/** The resting reach target's bounds, in CSS px. It tracks the tile's own
 * on-screen side between these: never under the 44px house floor
 * for a touch target, and capped so that even zoomed far into a now
 * cluster-sized tile, the hover zone stays the pond rather than the whole
 * viewport. */
const REST_MIN = 44;
const REST_MAX = 320;

/** Where the pane opens before she has ever dragged it, and the floor it can be
 * dragged to.
 *
 * The default is generous on purpose — it's the size at which a median day's
 * column actually fits the drawing box (see the sweep behind PANE_ZOOMS), and a
 * pane whose typical column is cut off is a pane arguing with its own data. The
 * floor is set by the house rules rather than by the drawing: below this the
 * 40px controls stop fitting, and a pane she can't work is worse than a small
 * one. */
const PANE_DEFAULT = { w: 460, h: 360 };
const PANE_MIN = { w: 288, h: 216 };

/** How far a pinch has to travel before it steps a zoom rung. Discrete rungs
 * rather than continuous scale, so the pane and the real pond share one ladder
 * — and so a mark size is always one of five known things rather than whatever
 * a gesture happened to land on. */
const PINCH_STEP = 1.35;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

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

  // Two reads of the same endpoint. The cheap silhouette rides along with the
  // map; the per-card sizes are only worth 22KB once she's actually looking.
  const shape = usePondShape(anchor !== null);
  const sized = usePondShape(reached, true);

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

  // --- the pane's furniture, remembered across visits -----------------------
  const [pane, setPane] = useState(() => {
    const saved = loadPondPane();
    return {
      w: clamp(saved.w ?? PANE_DEFAULT.w, PANE_MIN.w, 2000),
      h: clamp(saved.h ?? PANE_DEFAULT.h, PANE_MIN.h, 2000),
      zoom: clamp(saved.zoom ?? PANE_ZOOM_DEFAULT, 0, PANE_ZOOMS.length - 1),
      jump: (saved.jump === 'month' ? 'month' : 'week') as PaneJump,
    };
  });
  useEffect(() => {
    savePondPane(pane);
  }, [pane]);

  // Deliberately NOT remembered: the pane opens at now every time. See
  // savedView.ts — landing where she left it a week ago answers a question
  // nobody asked.
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    if (!reached) setScrollX(0);
  }, [reached]);

  // Size the resting reach target to the tile's square as drawn on screen.
  const restSide = clamp((anchor?.half ?? 0) * 2, REST_MIN, REST_MAX);

  const columns = useMemo(
    () => bucketShape(shape.data?.days ?? [], CRUDE_COLUMNS),
    [shape.data?.days],
  );

  // Her share of the pond, for the hairline — a pond that's mostly Keeper reads
  // a touch cooler than one that's mostly her own voice.
  const ownShare = useMemo(() => {
    if (columns.length === 0) return 0.5;
    const total = columns.reduce((s, c) => s + c.cards, 0);
    if (total === 0) return 0.5;
    return columns.reduce((s, c) => s + c.ownShare * c.cards, 0) / total;
  }, [columns]);

  // --- the pane's drawing box, measured rather than computed ----------------
  // The chrome around it (name, chips, controls) is flow content whose height
  // depends on how many filter chips she has set, so arithmetic here would be a
  // second copy of the CSS free to drift. The observer just asks.
  const drawRef = useRef<HTMLDivElement | null>(null);
  const [draw, setDraw] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = drawRef.current;
    if (!el || !reached) return;
    const observer = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setDraw({ w: r.width, h: r.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [reached]);

  const days = (sized.data?.days ?? []) as SizedDay[];
  const layout = useMemo(
    () =>
      layoutPane(days, {
        width: draw.w,
        height: draw.h,
        zoom: PANE_ZOOMS[pane.zoom],
        scrollX,
        jump: pane.jump,
      }),
    [days, draw.w, draw.h, pane.zoom, pane.jump, scrollX],
  );

  // --- paint ----------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ink, setInk] = useState<ThemeInk | null>(null);
  // Read once per reach rather than per frame: getComputedStyle is a forced
  // style read, and the theme changes at sunrise, not mid-drag.
  useEffect(() => {
    if (reached) setInk(readThemeInk());
  }, [reached]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !reached || draw.w <= 0 || draw.h <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(draw.w * dpr));
    canvas.height = Math.max(1, Math.round(draw.h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, draw.w, draw.h);
    const ramp = ink ? heatRamps(ink).ember : HEAT_RAMP_LIGHT;
    for (const column of layout.columns) {
      for (const mark of column.marks) {
        ctx.fillStyle = heatColor(mark.t, ramp);
        ctx.fillRect(column.x, mark.y, column.w, mark.h);
      }
    }
  }, [layout, draw.w, draw.h, ink, reached]);

  // --- reaching -------------------------------------------------------------
  // Blocked while a gesture is live: a drag that leaves the box, or a pinch
  // that lifts one finger outside it, must not collapse the pane mid-motion.
  const busy = useRef(false);
  const reach = useCallback(
    (next: boolean) => {
      if (!next && busy.current) return;
      setReached(next);
      onReach(next);
    },
    [onReach],
  );

  // Go into the pond. A visitor sees the landmark (its silhouette is counts,
  // never words) but the pond itself is the journal, so for them the tile
  // only ever settles back down.
  const enter = () => {
    reach(false);
    if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') return;
    void navigate({ to: '/terrain/pond' });
  };

  // --- panning and zooming --------------------------------------------------
  const zoomBy = useCallback((step: number) => {
    setPane((p) => {
      const next = clamp(p.zoom + step, 0, PANE_ZOOMS.length - 1);
      if (next === p.zoom) return p;
      // Hold the day at the right-hand edge still while the marks resize —
      // otherwise zooming silently travels through time.
      setScrollX((s) => (s / PANE_ZOOMS[p.zoom].colWidth) * PANE_ZOOMS[next].colWidth);
      return { ...p, zoom: next };
    });
  }, []);

  // A NATIVE listener, not onWheel, and non-passive on purpose: React attaches
  // wheel at the root as passive, so preventDefault there is a no-op — and
  // without it every scroll inside the pane would also zoom the terrain map
  // underneath it, which is exactly the seam that makes a thing feel broken.
  useEffect(() => {
    const el = drawRef.current;
    if (!el || !reached) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // A trackpad pinch arrives as ctrl+wheel. That's the browser's own
      // convention and it costs nothing to honour.
      if (e.ctrlKey || e.metaKey) {
        zoomBy(e.deltaY < 0 ? 1 : -1);
        return;
      }
      // Horizontal scrolling reads as moving the viewport; vertical reads as
      // scrolling down a feed. Both should end up going BACK in time, which
      // is why the two signs differ.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY;
      setScrollX((s) => Math.max(0, s + delta));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [reached, zoomBy]);

  // One finger pans, two pinch — the same bargain the map underneath makes.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<number | null>(null);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    busy.current = true;
    if (pointers.current.size === 2) pinchRef.current = spread();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const base = pinchRef.current;
      const now = spread();
      if (base && now > 0) {
        const ratio = now / base;
        if (ratio > PINCH_STEP) {
          zoomBy(1);
          pinchRef.current = now;
        } else if (ratio < 1 / PINCH_STEP) {
          zoomBy(-1);
          pinchRef.current = now;
        }
      }
      return;
    }
    // Drag right = pull the past toward her.
    setScrollX((s) => Math.max(0, s + (e.clientX - prev.x)));
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) busy.current = false;
  };

  const jumpBy = (units: number) => {
    const step = JUMP_DAYS[pane.jump] * PANE_ZOOMS[pane.zoom].colWidth;
    setScrollX((s) => Math.max(0, s + units * step));
  };

  // --- resizing -------------------------------------------------------------
  // Keep the grip under her finger, whichever way the pane is pinned. It is
  // centred on the tile horizontally, so the width grows both ways and the
  // delta is doubled. Vertically it depends on the placement: an ABOVE pane
  // is pinned at its bottom (the grip sits top-right and dragging up grows
  // it), a BELOW pane at its top (grip bottom-right, drag down), and an OVER
  // pane is centred, so its delta doubles too. The height is capped at the
  // room that placement has, so a drag never shoves the pane over the tile.
  const resizeFrom = useRef<
    { x: number; y: number; w: number; h: number; placement: PanePlacement } | null
  >(null);
  const onResizeDown = (placement: PanePlacement) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    resizeFrom.current = { x: e.clientX, y: e.clientY, w: pane.w, h: pane.h, placement };
    busy.current = true;
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const from = resizeFrom.current;
    if (!from || !anchor) return;
    e.stopPropagation();
    const dy = e.clientY - from.y;
    const grow = from.placement === 'above' ? -dy : from.placement === 'below' ? dy : dy * 2;
    const room = paneRoom(anchor, { width: window.innerWidth, height: window.innerHeight });
    setPane((p) => ({
      ...p,
      w: clamp(from.w + (e.clientX - from.x) * 2, PANE_MIN.w, window.innerWidth - 24),
      h: clamp(from.h + grow, PANE_MIN.h, Math.max(PANE_MIN.h, room[from.placement])),
    }));
  };
  const onResizeUp = () => {
    resizeFrom.current = null;
    busy.current = false;
  };

  // A pointer that isn't a mouse gets no hover — the first tap reaches, and the
  // Open button is the way in. Without this a phone would be stuck in whatever
  // state one tap left it in, with no way to leave.
  const isMouse = useRef(true);

  if (!anchor) return null;

  // Place every piece off the tile's square — see pondPlacement.ts.
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const label = placeLabel(anchor, viewport);
  const paneBox = placePane(anchor, { width: pane.w, height: pane.h }, viewport);
  const bridge = hoverBridge(anchor, restSide, paneBox);

  const empty = shape.data !== undefined && columns.length === 0;
  const overflowing = layout.columns.some((c) => c.overflow);
  const caption = paneCaption(layout);
  const placementClass =
    paneBox.placement === 'above'
      ? styles.above
      : paneBox.placement === 'below'
        ? styles.below
        : styles.over;

  return (
    // The layer spans the viewport but takes no pointer events itself — only
    // its pieces do. Hover is judged on the layer, so moving between pieces
    // (tile → bridge → pane) never counts as leaving the landmark.
    <div
      className={styles.layer}
      aria-label={
        reached
          ? `The pond — ${shape.data?.cards.toLocaleString() ?? ''} cards${caption ? `, showing ${caption}` : ''}`
          : 'The pond — your journal'
      }
      onPointerEnter={(e) => {
        isMouse.current = e.pointerType === 'mouse';
        if (e.pointerType === 'mouse') reach(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') reach(false);
      }}
      // focusin/focusout bubble, so this keeps the pane open while she tabs
      // between its own controls and closes it only when focus actually leaves.
      onFocus={() => reach(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) reach(false);
      }}
    >
      {/* RESTING: the drawing is the canvas tile underneath — this is only the
          way to reach it, laid exactly over the square, plus the name above.
          A mouse never notices the target (hovering already reached it), but
          a touch needs somewhere to tap, and the house floor is 40px. */}
      {!reached ? (
        <>
          <button
            type="button"
            className={styles.reachTarget}
            style={{
              left: anchor.x - restSide / 2,
              top: anchor.y - restSide / 2,
              width: restSide,
              height: restSide,
            }}
            aria-label="Open the pond"
            onClick={() => reach(true)}
          />
          <div className={styles.restLabel} style={{ left: label.x, top: label.y }}>
            {/* THE FILTER DISPLAY at rest: only the lit thread, as one quiet
                chip over the name. One word saying what the pond is currently
                about is worth more here than a row of settings. */}
            {facets.some((f) => f.kind === 'lit') ? (
              <span className={styles.filters}>
                {facets
                  .filter((f) => f.kind === 'lit')
                  .map((f) => (
                    <span key={`${f.kind}:${f.label}`} className={styles.chipLit}>
                      {f.label}
                    </span>
                  ))}
              </span>
            ) : null}
            <span className={styles.nameText}>Pond</span>
            {empty ? <span className={styles.note}>nothing in the pool yet</span> : null}
          </div>
        </>
      ) : null}

      {/* REACHED: an invisible strip joining the tile to the pane, so the
          mouse can travel between them without the pane closing. */}
      {reached ? (
        <span
          className={styles.bridge}
          style={{ left: bridge.left, top: bridge.top, width: bridge.width, height: bridge.height }}
          aria-hidden="true"
        />
      ) : null}

      {/* REACHED: the pane, rising out of the tile. The name is its header,
          the filters under it, then the drawing and one row of controls. */}
      {reached ? (
        <div
          className={`${styles.pane} ${placementClass}`}
          style={{
            left: paneBox.left,
            top: paneBox.top,
            width: paneBox.width,
            height: paneBox.height,
          }}
        >
          <div className={styles.stack}>
            <div className={styles.name}>
              <span className={styles.nameText}>Pond</span>
              {shape.data ? (
                <span className={styles.count}>{shape.data.cards.toLocaleString()} cards</span>
              ) : null}
              {/* The stretch on screen. The ramp is relative to this window, so
                  saying which window it is keeps the colour from being a claim
                  about today. */}
              {caption ? <span className={styles.caption}>{caption}</span> : null}
            </div>

            {empty ? <span className={styles.note}>nothing in the pool yet</span> : null}

            {/* THE FILTER DISPLAY, reached: everything she set. */}
            {facets.length > 0 ? (
              <span className={styles.filters}>
                {facets.map((f) => (
                  <span
                    key={`${f.kind}:${f.label}`}
                    className={f.kind === 'lit' ? styles.chipLit : styles.chip}
                  >
                    {f.label}
                  </span>
                ))}
              </span>
            ) : null}

            {/* The drawing. One mark per card, sized by how much was written,
                filling each day's column from the bottom. */}
            <div
              ref={drawRef}
              className={styles.draw}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
            >
              <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

              {/* A day with more in it than the pane is tall went over the rim.
                  Said with a soft fade rather than a clipped edge, and only when
                  it's actually happening — pinching out is the answer. */}
              {overflowing ? <span className={styles.rim} aria-hidden="true" /> : null}

              {sized.isPending ? <span className={styles.note}>reading the pond…</span> : null}

              <button
                type="button"
                className={`${styles.step} ${styles.stepBack}`}
                aria-label={`Back one ${pane.jump}`}
                disabled={layout.scrollX >= layout.maxScroll}
                onClick={() => jumpBy(1)}
              >
                ‹
              </button>
              <button
                type="button"
                className={`${styles.step} ${styles.stepFwd}`}
                aria-label={`Forward one ${pane.jump}`}
                disabled={layout.scrollX <= 0}
                onClick={() => jumpBy(-1)}
              >
                ›
              </button>
            </div>

            {/* Her voice against the Keeper's, as a hairline under the water. The
                one fact about the pond's contents that fits at this size. */}
            <span className={styles.ownBar} aria-hidden="true">
              <span className={styles.ownFill} style={{ width: `${Math.round(ownShare * 100)}%` }} />
            </span>

            {/* The jump unit and the way in, on one row. The unit is a filter on
                time, so it belongs beside the drawing rather than in a settings
                shelf; the door is a real button because a click on the drawing now
                belongs to panning. */}
            <div className={styles.footer}>
              <div className={styles.segmented} role="group" aria-label="Jump by">
                {(['week', 'month'] as PaneJump[]).map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    className={pane.jump === unit ? styles.segOn : styles.seg}
                    aria-pressed={pane.jump === unit}
                    onClick={() => setPane((p) => ({ ...p, jump: unit }))}
                  >
                    {unit === 'week' ? 'Week' : 'Month'}
                  </button>
                ))}
              </div>
              <button type="button" className={styles.enter} onClick={enter}>
                Open the pond →
              </button>
            </div>
          </div>

          {/* The corner grip. Dragging it changes how much TIME is on screen,
              not how big the marks are — that's the pinch. It sits on the
              pane's free corner: top-right when the pane is above the tile. */}
          <span
            className={styles.resize}
            role="separator"
            aria-label="Resize the pond pane"
            onPointerDown={onResizeDown(paneBox.placement)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
          />
        </div>
      ) : null}
    </div>
  );
}
