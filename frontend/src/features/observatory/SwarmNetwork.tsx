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
 *     thickens with how much, and an arrowhead points at whoever received
 *     them (one at each end when both did) — messageArrows.ts. The number
 *     beside an arrowhead is how many that agent received, so a
 *     conversation carries two numbers, one each way;
 *   - a dashed purple line is a handover: one session took over from the
 *     other when its context filled (continuation.py). Its arrowhead points
 *     at the one that took over.
 *
 * The swarm's helper (swarm_helper.py) sits in the middle of them all as a
 * bigger, filled dot. A BLUE line runs from it to each member it has sent
 * messages to, with how many on it and an arrowhead at the member. It glows
 * while it's running; tap it to open its chat.
 *
 * Pointing the mouse at a ring also lights that agent's orb on the Terrain
 * map, when the map is open in another tile (shell/panels/agentHoverBus.ts).
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
 * middle and not be scrolly around." Then: "I also want some arrow
 * directionality of the messages." Then: "i want to know which direction
 * the number of messages flowed."
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import { makeStickyToggle } from '../terrain/codeHeatPref';
import { headSize, messageArrow, type MessageArrow, type Point } from './messageArrows';
import styles from './SwarmNetwork.module.css';
import { setClosedSwarmsShown, useClosedSwarmsShown, type Swarm } from './swarmApi';
import {
  directionCounts, layoutSwarm, lineWidth, nodeBoxes, placeCounts, shortTitle, type Box, type CountLine,
  withoutRetired,
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

  const pxPerUnit = shownWidth / layout.width;
  // Shape each message line's arrow. Sizes are worked out in screen pixels
  // and turned into drawing units, so a head stays the same size on screen
  // however wide the drawing is shown. A head's point stops just outside
  // the receiving agent's ring; an end with no head runs under its ring.
  const arrowBetween = (
    from: Point & { outer?: boolean }, fromHeaded: boolean,
    to: Point & { outer?: boolean }, toHeaded: boolean,
    widthPx: number,
  ): MessageArrow | null => {
    const clear = (node: { outer?: boolean }) => ((node.outer ? 12 : 18) + 2) / pxPerUnit;
    const head = headSize(widthPx);
    return messageArrow(
      { at: from, clear: clear(from), headed: fromHeaded },
      { at: to, clear: clear(to), headed: toHeaded },
      { length: head.length / pxPerUnit, halfWidth: head.halfWidth / pxPerUnit },
    );
  };
  const corners = (points: Point[]) => points.map((p) => `${p.x},${p.y}`).join(' ');
  // Shape every line's arrow once, for the drawing and for the counts below.
  // A talk line has a head at each end that received messages; the helper's
  // line and a handover have one, at the member and at the successor.
  const talkArrows = new Map(layout.talk.map((t) =>
    [`t-${t.a}-${t.b}`, arrowBetween(at.get(t.a)!, t.bToA > 0, at.get(t.b)!, t.aToB > 0, lineWidth(t.messages))] as const));
  const helperArrows = new Map(threads.map((t) =>
    [`h-${t.conv}`, arrowBetween(layout.centre, false, at.get(t.conv) ?? t, true, lineWidth(t.messages) - 0.5)] as const));
  const handoverArrows = new Map(layout.continues.map((c) =>
    [`c-${c.from}-${c.to}`, arrowBetween(at.get(c.from)!, false, at.get(c.to)!, true, 2)] as const));

  // Place every message count where it covers no ring, name, arrowhead or
  // other count (placeCounts). A talk line carries one number per direction,
  // each kept on the half of the line nearest whoever received those
  // messages (directionCounts); the helper's sits a little past halfway
  // toward the member. Talk counts go first.
  const headBox = (head: Point[] | null | undefined): Box[] => (head ? [{
    left: Math.min(...head.map((p) => p.x)), top: Math.min(...head.map((p) => p.y)),
    right: Math.max(...head.map((p) => p.x)), bottom: Math.max(...head.map((p) => p.y)),
  }] : []);
  const obstacles = [
    ...layout.nodes.flatMap((n) =>
      nodeBoxes(n, n.named ? shortTitle(n.title) : '', pxPerUnit, n.outer ? 12 : 18, layout.nameWidth - 8, n.nameAbove)),
    ...(swarm.helper_conv ? nodeBoxes(layout.centre, 'Helper', pxPerUnit) : []),
    ...[...talkArrows.values(), ...helperArrows.values(), ...handoverArrows.values()]
      .flatMap((arrow) => [...headBox(arrow?.headAtStart), ...headBox(arrow?.headAtEnd)]),
  ];
  const talkCounts = layout.talk.flatMap((t) => directionCounts(t).map((direction) => ({
    key: `t-${t.a}-${t.b}-${direction.receiver}`,
    line: t,
    direction,
    sender: direction.receiver === 'b' ? t.a : t.b,
    receiver: direction.receiver === 'b' ? t.b : t.a,
  })));
  const countLines: CountLine[] = [
    ...talkCounts.map((c) => ({
      key: c.key, from: at.get(c.line.a)!, to: at.get(c.line.b)!, text: String(c.direction.count),
      prefer: c.direction.prefer, within: c.direction.within,
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
        {threads.map((t) => {
          // The helper's line to one member, with a head at the member.
          const width = lineWidth(t.messages) - 0.5;
          const arrow = helperArrows.get(`h-${t.conv}`);
          const end = arrow?.end ?? t;
          return (
            <g key={`h-${t.conv}`}>
              <line x1={layout.centre.x} y1={layout.centre.y} x2={end.x} y2={end.y}
                className={styles.helperThread} strokeWidth={width} vectorEffect="non-scaling-stroke" />
              {arrow?.headAtEnd ? <polygon points={corners(arrow.headAtEnd)} className={styles.helperHead} /> : null}
            </g>
          );
        })}
        {layout.continues.map((c) => {
          // The handover line, with a head at the session that took over.
          const from = at.get(c.from)!;
          const arrow = handoverArrows.get(`c-${c.from}-${c.to}`);
          const end = arrow?.end ?? at.get(c.to)!;
          return (
            <g key={`c-${c.from}-${c.to}`}>
              <line x1={from.x} y1={from.y} x2={end.x} y2={end.y}
                className={styles.handover} vectorEffect="non-scaling-stroke" />
              {arrow?.headAtEnd ? <polygon points={corners(arrow.headAtEnd)} className={styles.handoverHead} /> : null}
            </g>
          );
        })}
        {layout.talk.map((t) => {
          const a = at.get(t.a)!;
          const b = at.get(t.b)!;
          // The talk line between two members, with a head at each end
          // that received messages. Too close for heads: the bare line.
          const width = lineWidth(t.messages);
          const arrow = talkArrows.get(`t-${t.a}-${t.b}`);
          const start = arrow?.start ?? a;
          const end = arrow?.end ?? b;
          return (
            <g key={`t-${t.a}-${t.b}`}>
              <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                className={styles.talk} strokeWidth={width} vectorEffect="non-scaling-stroke" />
              {arrow?.headAtStart ? <polygon points={corners(arrow.headAtStart)} className={styles.talkHead} /> : null}
              {arrow?.headAtEnd ? <polygon points={corners(arrow.headAtEnd)} className={styles.talkHead} /> : null}
            </g>
          );
        })}
      </svg>

      {/* How many messages went each way, each number on its line beside
          the arrowhead of whoever received them, clear of the rest. */}
      {talkCounts.map((c) => {
        const spot = countAt.get(c.key)!;
        return (
          <span
            key={`n-${c.key}`}
            className={styles.count}
            style={place(spot.x, spot.y)}
            title={`${titleOf(c.sender)} → ${titleOf(c.receiver)}: ${c.direction.count}`}
          >
            {c.direction.count}
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
          {...agentPointerProps(n.conv)}
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
          {...agentPointerProps(swarm.helper_conv)}
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
      <span><span className={styles.keyTalk} aria-hidden="true" /> messages between them: the arrow points at who received them, the number beside it is how many they received</span>
      <span><span className={styles.keyHandover} aria-hidden="true" /> one took over from the other: the arrow points at the one that took over</span>
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
