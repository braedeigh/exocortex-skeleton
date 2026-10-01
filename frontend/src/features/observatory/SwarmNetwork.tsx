/**
 * SwarmNetwork.tsx — one swarm drawn as a network: its sessions as purple
 * rings, green lines between the ones that have messaged each other.
 *
 * What this is, in plain English: each agent is a still purple ring (the
 * app's --accent) around a solid dot. While it works, the dot glows in and
 * out and a teal arc spins around it; while it waits on her, a second,
 * orange ring sits outside the purple one; silent, it steps back. Retired
 * agents (archived, or handed on to a successor) can be hidden with the
 * switch in the key, which remembers its setting. In a bigger swarm the
 * retired ones sit on an outer ring, smaller and dimmer, round the active
 * ones; when that ring is too crowded for names, a name shows on hover, or
 * on a first tap (a second tap opens it). The agents are joined by
 * lines:
 *
 *   - a GREEN line is talk: these two have sent each other messages. It
 *     thickens with how much, and the number on it says how many each way;
 *   - a dashed purple line is a handover: one session took over from the
 *     other when its context filled (continuation.py).
 *
 * The swarm's helper (swarm_helper.py) sits in the middle of them all as a
 * bigger, filled dot. A BLUE line runs from it to each member it has sent
 * messages to, with how many on it. It glows while it's running; tap it
 * to open its chat.
 *
 * The lines are an SVG underneath; the rings, names and counts are ordinary
 * HTML placed on top by percentage, so they keep real, readable pixel sizes
 * and ~40px taps. The drawing never scrolls sideways: it measures how wide
 * it is shown and the layout is fitted to that width (swarmNetworkMath.ts),
 * the helper in the middle. A name hangs under its ring, or sits above it
 * when the ring is above the helper, so lines running inward don't cross
 * it. On a narrow screen the names wrap narrower, and
 * a ring with no room for its names shows them on hover or a first tap.
 * Inside the round bubble of a room's swarm stack (`round`), everything
 * stays inside the circle with the helper at its exact centre. Tap a ring
 * to open that session.
 *
 * Touches: swarmNetworkMath.ts (where everything sits — tested), swarmApi.ts
 * (the Swarm shape), SwarmNetwork.module.css. Used by WorktreeMapPage.tsx
 * (every swarm, under the plots), SwarmPage.tsx (its own swarm) and
 * SwarmStack.tsx (the bubble in a room).
 *
 * Prompt that produced it: "a tree or like network of agents below the tree
 * representing the swarm with green lines between the purple agent rings
 * showing which are talking to which within the swarm." Then: "a solid dot
 * in the center that glows in and out and has a teal outline spinning around
 * it. then instead of pinging orange, just an orange ring additionally. make
 * them all static. then make it such that i can hide retired agents from the
 * swarm display." Then: "make it such that the helper is connected to other
 * agents in the swarm with the threads for messages it sends." Then: "I'm
 * wondering if retired agents should show in a ring outside the active
 * agents." Then: "I also want this to be centered with the helper in the
 * middle and not be scrolly around."
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { makeStickyToggle } from '../terrain/codeHeatPref';
import styles from './SwarmNetwork.module.css';
import { setClosedSwarmsShown, useClosedSwarmsShown, type Swarm } from './swarmApi';
import {
  layoutSwarm, lineWidth, nodeBoxes, placeCounts, shortTitle, type CountLine, withoutRetired,
} from './swarmNetworkMath';

/** How wide the drawing is shown, in pixels, kept up to date as the page
 * resizes (a ResizeObserver). It is measured before the first paint, so the
 * layout is fitted to the real width from the start; the 320 is only what
 * that first, unseen pass assumes. Returns a setter to hand the drawing's
 * element to (a callback ref), and the width. */
function useShownWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    if (!element) return;
    const measured = element.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

/* The "hide retired" switch: a toggle that stays (localStorage), shared by
   every swarm drawing on every page, so hiding them once hides them
   everywhere. Off unless she turns it on. */
const retiredHiddenToggle = makeStickyToggle('swarm-network-retired-hidden');

export function SwarmNetwork({
  swarm,
  onOpen,
  helperWorking = false,
  round = false,
}: {
  swarm: Pick<Swarm, 'members' | 'links' | 'continues' | 'helper_conv' | 'helper_links'>;
  onOpen: (conv: string) => void;
  /** Whether the helper is mid-run, from the roster. */
  helperWorking?: boolean;
  /** Whether it sits inside a circle as wide as itself (a swarm stack's
   * bubble): the layout then keeps everything inside that circle. */
  round?: boolean;
}) {
  // Leave retired members out when the switch is on. Their lines move onto
  // the live session that took over from them (withoutRetired), so a
  // continuation doesn't look unconnected.
  const hideRetired = retiredHiddenToggle.useOn();
  const shownSwarm = hideRetired ? withoutRetired(swarm) : swarm;
  const members = shownSwarm.members;
  const hiddenCount = swarm.members.length - members.length;
  // Fit the layout to the width the drawing is shown at.
  const [canvasRef, shownWidth] = useShownWidth();
  const layout = layoutSwarm(shownSwarm, shownWidth, round);
  // The helper's threads only show when its seat does.
  const threads = swarm.helper_conv ? layout.helperThreads : [];
  // The one unnamed outer ring whose name a first tap has shown, if any.
  const [peek, setPeek] = useState<string | null>(null);
  // Whether the last press was a mouse, whose hover already showed the name.
  const pressedWithMouse = useRef(false);
  const at = new Map(layout.nodes.map((n) => [n.conv, n] as const));

  // Place every message count where it covers no ring, name or other
  // count (placeCounts). Talk counts go first and prefer their line's
  // middle; the helper's prefer a little past halfway toward the member.
  const pxPerUnit = shownWidth / layout.width;
  const obstacles = [
    ...layout.nodes.flatMap((n) =>
      nodeBoxes(n, n.named ? shortTitle(n.title) : '', pxPerUnit, n.outer ? 12 : 18, layout.nameWidth - 8, n.nameAbove)),
    ...(swarm.helper_conv ? nodeBoxes(layout.centre, 'Helper', pxPerUnit) : []),
  ];
  const countLines: CountLine[] = [
    ...layout.talk.map((t) => ({
      key: `t-${t.a}-${t.b}`, from: at.get(t.a)!, to: at.get(t.b)!, text: String(t.messages), prefer: 0.5,
    })),
    ...threads.map((t) => ({
      key: `h-${t.conv}`, from: layout.centre, to: t, text: String(t.messages), prefer: 0.6,
    })),
  ];
  const countAt = placeCounts(countLines, obstacles, pxPerUnit, layout);
  const titleOf = (conv: string) => at.get(conv)?.title ?? conv;
  // Place HTML over the drawing by percentage of its box.
  const place = (x: number, y: number): CSSProperties => ({
    left: `${(x / layout.width) * 100}%`,
    top: `${(y / layout.height) * 100}%`,
  });
  // Keep a nameless ring's pop-up name inside the drawing. The name chip is
  // centred under its ring; near a side edge it is pushed back in by this
  // many pixels (assuming the chip at its widest, 180px).
  const peekShift = (x: number): number => {
    const centre = x * pxPerUnit;
    const reach = Math.min(90, shownWidth / 2);
    return Math.round(Math.max(reach, Math.min(shownWidth - reach, centre)) - centre);
  };

  if (members.length === 0) {
    return <p className={styles.allHidden}>All {hiddenCount} agents here are retired (hidden).</p>;
  }

  return (
    <div ref={canvasRef} className={styles.canvas} style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
      {/* The lines, underneath. Stroke widths stay in screen pixels. */}
      <svg
        className={styles.lines}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {threads.map((t) => (
          <line key={`h-${t.conv}`} x1={layout.centre.x} y1={layout.centre.y} x2={t.x} y2={t.y}
            className={styles.helperThread} strokeWidth={lineWidth(t.messages) - 0.5} vectorEffect="non-scaling-stroke" />
        ))}
        {layout.continues.map((c) => {
          const from = at.get(c.from)!;
          const to = at.get(c.to)!;
          return (
            <line key={`c-${c.from}-${c.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              className={styles.handover} vectorEffect="non-scaling-stroke" />
          );
        })}
        {layout.talk.map((t) => {
          const a = at.get(t.a)!;
          const b = at.get(t.b)!;
          return (
            <line key={`t-${t.a}-${t.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className={styles.talk} strokeWidth={lineWidth(t.messages)} vectorEffect="non-scaling-stroke" />
          );
        })}
      </svg>

      {/* How many messages each line carries, on its line, clear of the rest. */}
      {layout.talk.map((t) => {
        const spot = countAt.get(`t-${t.a}-${t.b}`)!;
        return (
          <span
            key={`n-${t.a}-${t.b}`}
            className={styles.count}
            style={place(spot.x, spot.y)}
            title={`${titleOf(t.a)} → ${titleOf(t.b)}: ${t.aToB} · ${titleOf(t.b)} → ${titleOf(t.a)}: ${t.bToA}`}
          >
            {t.messages}
          </span>
        );
      })}

      {/* How many messages the helper has sent along each thread. */}
      {threads.map((t) => (
        <span
          key={`hn-${t.conv}`}
          className={[styles.count, styles.helperCount].join(' ')}
          style={place(countAt.get(`h-${t.conv}`)!.x, countAt.get(`h-${t.conv}`)!.y)}
          title={`Helper → ${titleOf(t.conv)}: ${t.messages}`}
        >
          {t.messages}
        </span>
      ))}

      {/* The agents: a ring and its name, tap to open. */}
      {/* An unnamed outer ring opens on a mouse click or a second tap; a
          first tap only shows its name. */}
      {layout.nodes.map((n) => (
        <button
          key={n.conv}
          type="button"
          className={[styles.node, styles[`state_${n.state}`], n.retired ? styles.retired : '',
            n.outer ? styles.outer : '', n.named ? '' : styles.unnamed, n.nameAbove ? styles.above : '', peek === n.conv ? styles.peeked : '']
            .filter(Boolean).join(' ')}
          style={n.named
            ? { ...place(n.x, n.y), width: layout.nameWidth }
            : { ...place(n.x, n.y), '--peek-shift': `${peekShift(n.x)}px` } as CSSProperties}
          onPointerDown={(event) => { pressedWithMouse.current = event.pointerType === 'mouse'; }}
          onClick={() => {
            if (!n.named && !pressedWithMouse.current && peek !== n.conv) setPeek(n.conv);
            else onOpen(n.conv);
          }}
          onBlur={() => setPeek((current) => (current === n.conv ? null : current))}
          title={n.title}
          aria-label={n.named ? undefined : n.title}
        >
          {/* The ring and its dot. Everything is still except, while it
              works, the dot's glow and the teal arc spinning round it. */}
          <svg width={n.outer ? 24 : 32} height={n.outer ? 24 : 32} viewBox="0 0 32 32"
            className={styles.ringBox} aria-hidden="true">
            <circle cx="16" cy="16" r="10" className={styles.ring} />
            {n.state === 'needs_input'
              ? <circle cx="16" cy="16" r="14.5" className={styles.waitRing} />
              : <circle cx="16" cy="16" r="14" className={styles.halo} />}
            {n.state === 'working' ? <circle cx="16" cy="16" r="6.5" className={styles.spinner} /> : null}
            <circle cx="16" cy="16" r="3.5" className={styles.dot} />
          </svg>
          <span className={styles.name}>{shortTitle(n.title)}</span>
        </button>
      ))}

      {/* The helper, in the middle of them all: tap to open its chat. */}
      {swarm.helper_conv ? (
        <button
          type="button"
          className={[styles.node, styles.helper, helperWorking ? styles.state_working : ''].filter(Boolean).join(' ')}
          style={place(layout.centre.x, layout.centre.y)}
          onClick={() => onOpen(swarm.helper_conv!)}
          title="The swarm's helper — tap to open its chat"
        >
          <svg width="32" height="32" viewBox="0 0 32 32" className={styles.ringBox} aria-hidden="true">
            <circle cx="16" cy="16" r="14" className={styles.halo} />
            {helperWorking ? <circle cx="16" cy="16" r="12" className={styles.spinner} /> : null}
            <circle cx="16" cy="16" r="9" className={styles.dot} />
          </svg>
          <span className={styles.name}>Helper</span>
        </button>
      ) : null}
    </div>
  );
}

/** The key to the drawing, in the same words as the Worktrees legend. */
export function SwarmNetworkKey() {
  const hideRetired = retiredHiddenToggle.useOn();
  return (
    <div className={styles.key}>
      <span><span className={styles.keyTalk} aria-hidden="true" /> messages between them (the number is how many)</span>
      <span><span className={styles.keyHandover} aria-hidden="true" /> one took over from the other</span>
      <span><span className={styles.keyHelper} aria-hidden="true" /> the helper's messages to them</span>
      {/* The retired switch lives with the key, so it shows once per page
          however many swarms are drawn below it. */}
      <button
        type="button"
        className={styles.retiredToggle}
        aria-pressed={hideRetired}
        onClick={() => retiredHiddenToggle.set(!hideRetired)}
      >
        {hideRetired ? 'Show retired agents' : 'Hide retired agents'}
      </button>
    </div>
  );
}

/** The switch that shows or hides closed swarms (fewer than two sessions
 * still at work).
 * Drawn only when there are closed swarms to show, beside the swarms it
 * governs; the setting is shared by every page (swarmApi.shownSwarms). */
export function ClosedSwarmsToggle({ closedCount }: { closedCount: number }) {
  const showClosed = useClosedSwarmsShown();
  if (closedCount === 0) return null;
  return (
    <button
      type="button"
      className={styles.retiredToggle}
      aria-pressed={showClosed}
      onClick={() => setClosedSwarmsShown(!showClosed)}
    >
      {showClosed
        ? 'Hide closed swarms'
        : `Show ${closedCount} closed ${closedCount === 1 ? 'swarm' : 'swarms'}`}
    </button>
  );
}
