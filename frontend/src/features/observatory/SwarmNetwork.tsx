/**
 * SwarmNetwork.tsx — one swarm drawn as a network: its sessions as purple
 * rings, green lines between the ones that have messaged each other.
 *
 * What this is, in plain English: each agent is a still purple ring (the
 * app's --accent) around a solid dot. While it works, the dot glows in and
 * out and a teal arc spins around it; while it waits on her, a second,
 * orange ring sits outside the purple one; silent, it steps back. Retired
 * agents (archived, or handed on to a successor) can be hidden with the
 * switch in the key, which remembers its setting. The agents are joined by
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
 * and ~40px taps however narrow the screen scales the drawing. Tap a ring to
 * open that session.
 *
 * Touches: swarmNetworkMath.ts (where everything sits — tested), swarmApi.ts
 * (the Swarm shape), SwarmNetwork.module.css. Used by WorktreeMapPage.tsx
 * (every swarm, under the plots) and SwarmPage.tsx (its own swarm).
 *
 * Prompt that produced it: "a tree or like network of agents below the tree
 * representing the swarm with green lines between the purple agent rings
 * showing which are talking to which within the swarm." Then: "a solid dot
 * in the center that glows in and out and has a teal outline spinning around
 * it. then instead of pinging orange, just an orange ring additionally. make
 * them all static. then make it such that i can hide retired agents from the
 * swarm display." Then: "make it such that the helper is connected to other
 * agents in the swarm with the threads for messages it sends."
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { makeStickyToggle } from '../terrain/codeHeatPref';
import styles from './SwarmNetwork.module.css';
import type { Swarm } from './swarmApi';
import {
  layoutSwarm, lineWidth, nodeBoxes, NETWORK_WIDTH, placeCounts, shortTitle, type CountLine,
} from './swarmNetworkMath';

/** How wide the drawing is shown, in pixels, kept up to date as the page
 * resizes (a ResizeObserver). Until it's measured, assume its narrowest:
 * the canvas's min-width, 460px. */
function useShownWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(460);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 460));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/* The "hide retired" switch: a toggle that stays (localStorage), shared by
   every swarm drawing on every page, so hiding them once hides them
   everywhere. Off unless she turns it on. */
const retiredHiddenToggle = makeStickyToggle('swarm-network-retired-hidden');

export function SwarmNetwork({
  swarm,
  onOpen,
  helperWorking = false,
}: {
  swarm: Pick<Swarm, 'members' | 'links' | 'continues' | 'helper_conv' | 'helper_links'>;
  onOpen: (conv: string) => void;
  /** Whether the helper is mid-run, from the roster. */
  helperWorking?: boolean;
}) {
  // Leave retired members out when the switch is on. Their lines go with
  // them: the layout only draws lines between members it was given.
  const hideRetired = retiredHiddenToggle.useOn();
  const members = hideRetired ? swarm.members.filter((m) => !m.retired) : swarm.members;
  const hiddenCount = swarm.members.length - members.length;
  const layout = layoutSwarm({ ...swarm, members });
  // The helper's threads only show when its seat does.
  const threads = swarm.helper_conv ? layout.helperThreads : [];
  const [canvasRef, shownWidth] = useShownWidth();
  const at = new Map(layout.nodes.map((n) => [n.conv, n] as const));

  // Place every message count where it covers no ring, name or other
  // count (placeCounts). Talk counts go first and prefer their line's
  // middle; the helper's prefer a little past halfway toward the member.
  const pxPerUnit = shownWidth / NETWORK_WIDTH;
  const obstacles = [
    ...layout.nodes.flatMap((n) => nodeBoxes(n, shortTitle(n.title), pxPerUnit)),
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

  if (members.length === 0) {
    return <p className={styles.allHidden}>All {hiddenCount} agents here are retired (hidden).</p>;
  }

  return (
    <div className={styles.scroller}>
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
        {layout.nodes.map((n) => (
          <button
            key={n.conv}
            type="button"
            className={[styles.node, styles[`state_${n.state}`], n.retired ? styles.retired : '']
              .filter(Boolean).join(' ')}
            style={place(n.x, n.y)}
            onClick={() => onOpen(n.conv)}
            title={n.title}
          >
            {/* The ring and its dot. Everything is still except, while it
                works, the dot's glow and the teal arc spinning round it. */}
            <svg width="32" height="32" viewBox="0 0 32 32" className={styles.ringBox} aria-hidden="true">
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
