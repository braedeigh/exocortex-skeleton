import { useState } from 'react';
import styles from './TerrainAgentBar.module.css';

/**
 * TerrainAgentBar — the bottom agent control.
 *
 *   [ Working ▾ ]  ◀──────█████──────▶   [ Agents · 8 ]
 *
 * - **The pool button** opens a popup anchored to itself with two rows of
 *   choices, and its own label becomes whatever you picked:
 *     · WHICH AGENTS — Working (did something within the hour) / Open (not
 *       archived) / All (the whole roster).
 *     · WHICH SECTION — All / Personal / Orchestra.
 *   Both are server-side facts, so they mean the same thing on every device.
 *   This pool used to mean a browser-local heartbeat, which was invisible and
 *   evaporated half an hour after she looked away.
 * - **The window**: a dual-handle slider that slides over the *chosen pool*,
 *   ranked most-recent-first — not over the calendar (that's the top Dates
 *   dial's job). It is never dimmed or inert now: the button picks the pool,
 *   the window picks a slice of it, and those are two different questions.
 *   Before, the pool and the window were two owners of one value, so one of
 *   them had to be switched off to stop them disagreeing.
 * - **Agents button**: toggles a popup list of the agents currently shown —
 *   tap a row to spotlight that agent's footprint. No inline chips; the bar
 *   stays a control strip, the list is where identity lives.
 * - **Hide**, at the end: takes every agent off the map — orbs, tethers,
 *   rings, names — leaving files only. While hidden the whole bar folds down
 *   to one **Show agents** button: the pool and the window choose among
 *   agents that aren't being drawn, so showing them would be offering
 *   controls that do nothing. Both choices are kept and come back as they
 *   were. The switch itself stays across reloads (agentsHiddenPref.ts).
 *   Prompt: "make it possible to hide agents".
 *
 * Selection/visibility state is owned by TerrainPage; this is presentation +
 * the gestures. The dual-handle mechanics mirror TerrainDials' Dates row
 * exactly (only the thumbs take pointer events, so the handle you touch is the
 * one that moves).
 *
 * Prompt that produced the selector: "i want it to be options for open,
 * active, and then also filter by which section they're in… you click the
 * active button, it makes a little popup right there, you click one, and it
 * changes it to fit there."
 */

/** Which agents are eligible at all. */
export type AgentPool = 'active' | 'open' | 'all';
/** Which room they live in. '' = no filter. Mirrors the Observatory's lanes
 * (observatory/api.ts) — a room missing here would make its sessions
 * unreachable from this bar, so the two lists move together. */
export type AgentSection = '' | 'personal' | 'coding' | 'research' | 'orchestra';

/* 'active' shows as "Working", not "Active". The word was doing two unrelated
   jobs one row apart: this button picks a POOL OF AGENTS (worked in the last
   hour), while the Active bar directly above it puts a window on which FILES
   ran. Two controls, one label, stacked vertically.
   Prompt: "i also see that there are 3 bars at once right now". */
export const POOL_LABELS: Record<AgentPool, string> = {
  active: 'Working',
  open: 'Open',
  all: 'All',
};

const POOL_HINTS: Record<AgentPool, string> = {
  active: 'Worked in the last hour',
  open: 'Not archived',
  all: 'Every session on record',
};

export const SECTION_LABELS: Record<AgentSection, string> = {
  '': 'All',
  personal: 'Personal',
  coding: 'Coding',
  research: 'Research',
  orchestra: 'Orchestra',
};

const POOLS: readonly AgentPool[] = ['active', 'open', 'all'];
const SECTIONS: readonly AgentSection[] = ['', 'personal', 'coding', 'research', 'orchestra'];

export interface AgentEntry {
  id: string;
  title: string;
  running: boolean;
  /** Did something within the last hour — what "Active" means now. */
  active: boolean;
  /** Not archived. */
  open: boolean;
  /** 'personal' | 'coding' | 'research' | 'orchestra' | ''. */
  lane: string;
  files: number;
  last: number | null;
}

export interface TerrainAgentBarProps {
  /** The chosen pool, ranked most-recent-first — what the window slides over. */
  ranked: AgentEntry[];
  /** Ids actually shown right now (page computes from pool + section + window). */
  shownIds: ReadonlySet<string>;
  pool: AgentPool;
  section: AgentSection;
  onPool: (pool: AgentPool) => void;
  onSection: (section: AgentSection) => void;
  /** Window over `ranked` by index, [from, to). */
  from: number;
  to: number;
  onWindow: (from: number, to: number) => void;
  /** True while agents are hidden from the map altogether. */
  hidden: boolean;
  onHidden: (hidden: boolean) => void;
  /** The spotlighted agent id (footprint ringed on the map), or null. */
  spotlighted: string | null;
  onSpotlight: (id: string | null) => void;
}

export function TerrainAgentBar({
  ranked,
  shownIds,
  pool,
  section,
  onPool,
  onSection,
  from,
  to,
  onWindow,
  hidden,
  onHidden,
  spotlighted,
  onSpotlight,
}: TerrainAgentBarProps) {
  const [listOpen, setListOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);

  const n = ranked.length;
  // Clamp the window to the current roster: switching pools can shrink `n`
  // under a handle that was parked further out.
  const wTo = Math.min(Math.max(to, 1), Math.max(1, n));
  const wFrom = Math.min(Math.max(from, 0), Math.max(0, wTo - 1));
  const pct = (i: number) => (n > 0 ? (i / n) * 100 : 0);

  const shownList = ranked.filter((a) => shownIds.has(a.id));
  // The button says what it's showing. Section is only named when it's
  // actually filtering — "Active" beats "Active · All" for the common case.
  const poolLabel = section
    ? `${POOL_LABELS[pool]} · ${SECTION_LABELS[section]}`
    : POOL_LABELS[pool];

  // Agents are hidden: fold the bar down to the one button that brings them
  // back. Lit like any engaged control, so it reads as "a filter is on" and
  // not as an empty bar.
  if (hidden) {
    return (
      <div className={styles.bar} role="group" aria-label="Agents">
        <button
          type="button"
          className={`${styles.btn} ${styles.btnOn}`}
          aria-pressed
          onClick={() => onHidden(false)}
          title="Agents are hidden — put them back on the map"
        >
          Show agents
        </button>
      </div>
    );
  }

  return (
    <div className={styles.bar} role="group" aria-label="Agents">
      <div className={styles.listWrap}>
        <button
          type="button"
          className={[styles.btn, poolOpen ? styles.btnOn : ''].filter(Boolean).join(' ')}
          aria-haspopup="menu"
          aria-expanded={poolOpen}
          onClick={() => setPoolOpen((v) => !v)}
          title="Which agents the map draws"
        >
          {poolLabel} <span className={styles.caret} aria-hidden="true">▾</span>
        </button>
        {poolOpen ? (
          <div className={styles.pop} role="menu">
            <div className={styles.popHead}>Which agents</div>
            {POOLS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={pool === p}
                className={[styles.popRow, pool === p ? styles.popRowOn : ''].filter(Boolean).join(' ')}
                onClick={() => {
                  onPool(p);
                  setPoolOpen(false);
                }}
              >
                <span className={styles.popLabel}>{POOL_LABELS[p]}</span>
                <span className={styles.popHint}>{POOL_HINTS[p]}</span>
              </button>
            ))}
            <div className={styles.popHead}>Section</div>
            {SECTIONS.map((s) => (
              <button
                key={s || 'all'}
                type="button"
                role="menuitemradio"
                aria-checked={section === s}
                className={[styles.popRow, section === s ? styles.popRowOn : ''].filter(Boolean).join(' ')}
                onClick={() => {
                  onSection(s);
                  setPoolOpen(false);
                }}
              >
                <span className={styles.popLabel}>{SECTION_LABELS[s]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* The window over the chosen pool. */}
      <div className={styles.window}>
        <div className={styles.dualTrack}>
          <span
            className={styles.selected}
            style={{ left: `${pct(wFrom)}%`, right: `${100 - pct(wTo)}%` }}
            aria-hidden="true"
          />
          <input
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={0}
            max={Math.max(1, n)}
            step={1}
            value={wFrom}
            disabled={n === 0}
            onChange={(e) => onWindow(Math.min(Number(e.target.value), wTo - 1), wTo)}
            aria-label="Newest agent shown"
          />
          <input
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={0}
            max={Math.max(1, n)}
            step={1}
            value={wTo}
            disabled={n === 0}
            onChange={(e) => onWindow(wFrom, Math.max(Number(e.target.value), wFrom + 1))}
            aria-label="Oldest agent shown"
          />
        </div>
      </div>

      <div className={styles.listWrap}>
        <button
          type="button"
          className={[styles.btn, listOpen ? styles.btnOn : ''].filter(Boolean).join(' ')}
          aria-pressed={listOpen}
          aria-expanded={listOpen}
          onClick={() => setListOpen((v) => !v)}
        >
          Agents · {shownIds.size}
        </button>
        {listOpen ? (
          <div className={`${styles.pop} ${styles.popRight}`} role="menu">
            {shownList.length === 0 ? (
              <div className={styles.popEmpty}>No agents in range</div>
            ) : (
              shownList.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={spotlighted === a.id}
                  className={[styles.popRow, spotlighted === a.id ? styles.popRowOn : '']
                    .filter(Boolean)
                    .join(' ')}
                  title={`${a.files} ${a.files === 1 ? 'file' : 'files'} touched`}
                  onClick={() => onSpotlight(spotlighted === a.id ? null : a.id)}
                >
                  {a.running ? <span className={styles.runDot} aria-hidden="true" /> : null}
                  <span className={styles.popLabel}>{a.title}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      {/* Hide every agent. Closes both popups on the way out, so neither is
          still open when the bar comes back. */}
      <button
        type="button"
        className={styles.btn}
        onClick={() => {
          setListOpen(false);
          setPoolOpen(false);
          onHidden(true);
        }}
        title="Take every agent off the map — files only"
      >
        Hide
      </button>
    </div>
  );
}
