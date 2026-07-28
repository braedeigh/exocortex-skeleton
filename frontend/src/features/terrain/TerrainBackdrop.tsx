import { useEffect, useRef, useState } from 'react';
import { subscribeTheme } from '../../theme';
import { useTerrain, type TerrainData } from './api';
import { breathHalfLife, buildTerrainGraph, changedFileIds } from './terrainGraph';
import { readThemeInk, TerrainCanvas } from './terrainCanvas';
import styles from './TerrainBackdrop.module.css';

/**
 * TerrainBackdrop — the terrain map as wallpaper behind the Observatory.
 *
 * STEP 1 of the backdrop build (2026-07-24), and deliberately only step 1:
 * the map, dimmed, behind the conversation. No glass, no featured agent, no
 * burning scroll — those land as separate steps so each one can be looked at
 * on its own. An earlier attempt shipped all of them at once and there was no
 * way to tell which layer was the one failing.
 *
 * It's the same engine /terrain uses, at the same 350-file tier (her call:
 * the map should look like the map), running in the engine's `ambient` mode:
 * no gestures, no labels. Dimming is CSS opacity on the canvas rather than a
 * draw-time alpha, so the paint code stays identical on both surfaces.
 *
 * What survives the dimming and is meant to: the heat ramp's hot end, and the
 * one-shot flash on every file whose newest touch advanced between two
 * payloads. That flash is the whole "something is happening out there" signal
 * at this distance.
 *
 * THE BREATH (her 07-24 ask): the heat lens isn't fixed — it swells from a
 * one-day half-life out to a one-month one and back, once every ~10s. Because
 * widening the lens is non-uniform (old files enter the ramp, recent ones
 * barely move), the map appears to remember further back and then forget
 * again, rather than simply pulsing brighter. See breathHalfLife().
 *
 * It's driven straight into the engine on an interval rather than through
 * React state: the node SET never changes, only each node's heat, so
 * setGraph() takes its in-place path and the layout never re-warms — the map
 * holds perfectly still while its glow moves. Measured at 0.41ms per rebuild
 * for 373 nodes, so a rebuild per frame at this rate is cheaper than the
 * interpolation scheme it replaced.
 */

/** One full breath. Her pick: slow and deep, not a human 5s rhythm. */
const BREATH_PERIOD_MS = 10_000;
/** ~7fps. The glow moves slowly enough that more frames buy nothing, and this
 * is a background effect that has no business costing more than it must. */
const BREATH_TICK_MS = 150;
/** "As many dots as possible" (her 07-25 ask) — the room map is meant to be a
 * dense field, not the old 350 sample, and the focus camera frames the agent's
 * cluster within it. null = every file the payload will give. Dial back to a
 * numeric tier if the force sim ever feels heavy on a low-end phone. */
const BACKDROP_TIER = null;

/**
 * @param focusConv the conversation whose agent this backdrop stands behind —
 *   its orb eases to loosely centered and the files it has touched are ringed
 *   (white = read, purple = created-or-modified; freshly created files also
 *   fill green). Undefined on a session with no agent
 *   yet, where the backdrop just shows the whole breathing map.
 */
export function TerrainBackdrop({ focusConv }: { focusConv?: string | null } = {}) {
  const [anyRunning, setAnyRunning] = useState(false);
  const [onScreen, setOnScreen] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );

  // Poll fast only while something is actually working AND the PWA is on
  // screen — a wallpaper must never be the reason the phone gets warm.
  useEffect(() => {
    const onVis = () => setOnScreen(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const { data } = useTerrain(anyRunning && onScreen, BACKDROP_TIER);
  useEffect(() => {
    if (data) setAnyRunning((data.sessions ?? []).some((s) => s.running));
  }, [data]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TerrainCanvas | null>(null);
  const fittedRef = useRef(false);

  // The payload lives in a ref because the breath rebuilds the graph on its
  // own clock, outside React's render cycle.
  const dataRef = useRef<TerrainData | undefined>(undefined);
  dataRef.current = data;

  // The focused conversation, in a ref for the same reason — the breath's paint
  // loop (empty-dep effect) reads it to keep the focused agent in the active
  // set even while it sits momentarily idle behind her.
  const focusConvRef = useRef<string | null | undefined>(focusConv);
  focusConvRef.current = focusConv;

  // Engine lifecycle — one instance per mount, sized by ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new TerrainCanvas(canvas, readThemeInk(), { ambient: true });
    engineRef.current = engine;
    engine.resize(wrap.clientWidth, wrap.clientHeight);

    const ro = new ResizeObserver(() => engine.resize(wrap.clientWidth, wrap.clientHeight));
    ro.observe(wrap);
    const applyTheme = () => engine.setTheme(readThemeInk());
    const unsubscribe = subscribeTheme(applyTheme);
    const themeTimer = window.setInterval(applyTheme, 60_000);

    return () => {
      ro.disconnect();
      unsubscribe();
      window.clearInterval(themeTimer);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Follow this room's agent: loosely center its orb and ring the files it's
  // touched. Runs after the lifecycle effect above, so engineRef is set; a
  // null/absent focus returns the backdrop to whole-graph framing.
  useEffect(() => {
    engineRef.current?.setFocus(focusConv ?? null);
  }, [focusConv]);

  // The breath. One interval, alive only while the page is visible; a
  // reduced-motion preference freezes it at the midpoint rather than removing
  // the map, so the backdrop stays a picture instead of becoming an event.
  const breathStartRef = useRef(0);
  // Last half-life seen and which way it was heading — together they spot both
  // turns of the breath, which is when the focus sonar fires. Direction stays
  // null until two samples have established it.
  const breathPrevRef = useRef<number | null>(null);
  const breathRisingRef = useRef<boolean | null>(null);
  useEffect(() => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Phase origin is fixed for the life of the mount. It deliberately does
    // NOT reset per payload: this effect used to depend on `data`, so every
    // ~5s poll restarted the clock and snapped the breath back to the start
    // of its cycle. The interval reads dataRef, so it needs no data dep.
    if (breathStartRef.current === 0) breathStartRef.current = performance.now();
    const started = breathStartRef.current;

    const paint = () => {
      const engine = engineRef.current;
      const payload = dataRef.current;
      if (!engine || !payload) return;
      const elapsed = calm ? BREATH_PERIOD_MS / 2 : performance.now() - started;
      const half = breathHalfLife(elapsed, BREATH_PERIOD_MS);
      // The focused agent's purple sonar fires at BOTH turns of the breath —
      // the top, where the map stops widening its memory and starts letting it
      // go, and the bottom, where it turns back. Two rings per cycle, spaced
      // 4s and 6s apart by the breath's own asymmetry, so it beats unevenly
      // the way a living thing does rather than metronomically.
      //
      // Detected as any change of DIRECTION rather than by testing phase
      // against BREATH_INHALE_FRACTION: the inhale/exhale split has already
      // been retuned once (even → 4-in-6-out), and a turn is a turn whatever
      // the split becomes. `null` until the first two samples establish which
      // way it's going — without that, the opening sample would read as a turn
      // and fire a ring the breath never made. Under prefers-reduced-motion
      // the half-life is pinned, so it never changes, so this never fires.
      const prev = breathPrevRef.current;
      if (prev !== null && half !== prev) {
        const rising = half > prev;
        if (breathRisingRef.current !== null && breathRisingRef.current !== rising) {
          engine.pulseFocusSonar();
        }
        breathRisingRef.current = rising;
      }
      breathPrevRef.current = half;
      // Active set (her 07-27 call): only agents live right now get an orb, so
      // the wallpaper stops carrying the 90-day footprint backlog. The focused
      // conversation is always in it — she's standing behind it — so its orb
      // holds even between turns; the canvas then burns it brightest.
      const orbSessionIds = new Set<string>();
      for (const s of payload.sessions ?? []) if (s.running) orbSessionIds.add(s.id);
      const focus = focusConvRef.current;
      if (focus) orbSessionIds.add(focus);
      const graph = buildTerrainGraph(payload, half, undefined, { orbSessionIds });
      // Same node ids every time, so this updates heat in place and never
      // re-warms the layout — the map holds still, only the embers move.
      engine.setGraph(graph.nodes, graph.edges);
      if (!fittedRef.current && graph.nodes.length > 0) {
        fittedRef.current = true;
        engine.fitSoon();
      }
    };

    paint();
    if (calm) return;

    let timer: number | null = null;
    const sync = () => {
      const want = document.visibilityState === 'visible';
      if (want && timer === null) timer = window.setInterval(paint, BREATH_TICK_MS);
      else if (!want && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const prevDataRef = useRef<TerrainData | null>(null);
  useEffect(() => {
    if (!data) return;
    const prev = prevDataRef.current;
    prevDataRef.current = data;
    if (!prev) return;
    const changed = changedFileIds(prev, data);
    if (changed.size > 0) engineRef.current?.flash(changed);
  }, [data]);

  return (
    <div ref={wrapRef} className={styles.backdrop} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
