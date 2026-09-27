/**
 * SwarmNetwork.tsx — one swarm drawn as a network: its sessions as purple
 * rings, green lines between the ones that have messaged each other.
 *
 * What this is, in plain English: the same rings the Worktrees page and
 * Terrain use for an agent (the app's --accent purple, breathing while it
 * works, an orange sonar ping when it's waiting on her, dimmed when silent),
 * joined by lines:
 *
 *   - a GREEN line is talk: these two have sent each other messages. It
 *     thickens with how much, and the number on it says how many each way;
 *   - a dashed purple line is a handover: one session took over from the
 *     other when its context filled (continuation.py).
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
 * showing which are talking to which within the swarm."
 */
import type { CSSProperties } from 'react';
import styles from './SwarmNetwork.module.css';
import type { Swarm } from './swarmApi';
import { layoutSwarm, lineWidth, shortTitle } from './swarmNetworkMath';

export function SwarmNetwork({
  swarm,
  onOpen,
}: {
  swarm: Pick<Swarm, 'members' | 'links' | 'continues'>;
  onOpen: (conv: string) => void;
}) {
  const layout = layoutSwarm(swarm);
  const at = new Map(layout.nodes.map((n) => [n.conv, n] as const));
  const titleOf = (conv: string) => at.get(conv)?.title ?? conv;
  // Place HTML over the drawing by percentage of its box.
  const place = (x: number, y: number): CSSProperties => ({
    left: `${(x / layout.width) * 100}%`,
    top: `${(y / layout.height) * 100}%`,
  });

  return (
    <div className={styles.scroller}>
      <div className={styles.canvas} style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
        {/* The lines, underneath. Stroke widths stay in screen pixels. */}
        <svg
          className={styles.lines}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
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

        {/* How many messages each line carries, at its middle. */}
        {layout.talk.map((t) => {
          const a = at.get(t.a)!;
          const b = at.get(t.b)!;
          return (
            <span
              key={`n-${t.a}-${t.b}`}
              className={styles.count}
              style={place((a.x + b.x) / 2, (a.y + b.y) / 2)}
              title={`${titleOf(t.a)} → ${titleOf(t.b)}: ${t.aToB} · ${titleOf(t.b)} → ${titleOf(t.a)}: ${t.bToA}`}
            >
              {t.messages}
            </span>
          );
        })}

        {/* The agents: a ring and its name, tap to open. */}
        {layout.nodes.map((n) => (
          <button
            key={n.conv}
            type="button"
            className={[styles.node, styles[`state_${n.state}`]].join(' ')}
            style={place(n.x, n.y)}
            onClick={() => onOpen(n.conv)}
            title={n.title}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" className={styles.ringBox} aria-hidden="true">
              {n.state === 'needs_input' ? <circle cx="16" cy="16" r="10" className={styles.sonar} /> : null}
              <circle cx="16" cy="16" r="10" className={styles.ring} />
              <circle cx="16" cy="16" r="14" className={styles.halo} />
            </svg>
            <span className={styles.name}>{shortTitle(n.title)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The key to the drawing, in the same words as the Worktrees legend. */
export function SwarmNetworkKey() {
  return (
    <p className={styles.key}>
      <span className={styles.keyTalk} aria-hidden="true" /> messages between them (the number is how many)
      <span className={styles.keyHandover} aria-hidden="true" /> one took over from the other
    </p>
  );
}
