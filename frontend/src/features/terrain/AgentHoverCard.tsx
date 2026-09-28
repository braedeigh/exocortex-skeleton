import { createPortal } from 'react-dom';
import type { SessionMeta, SessionPreview } from '../observatory/api';
import { cardMetaLine } from '../observatory/sessionStatus';
import type { CardState } from '../observatory/sessionFilters';
import { hoverCardPlacement } from './agentHoverPlacement';
import type { AgentHover } from './terrainCanvas';
import styles from './AgentHoverCard.module.css';

/**
 * AgentHoverCard — put the cursor on an agent orb and the map tells you who it
 * is without you having to tap: the session's own card, floated beside the orb.
 *
 * IT IS THE ROSTER CARD, at the orb. Deliberately the same object the
 * Observatory draws (SessionLane) rather than a second thing that happens to
 * describe a session — same five-state dot, same badges, same housekeeping line
 * (both call sessionStatus.cardMetaLine), same what-you-asked-then-what-it's-
 * doing order. A colour or a stamp that meant one thing on the roster and
 * another on the map would make the map untrustworthy.
 *
 * Three deliberate differences, all of them because this is a MAP:
 *  - NO FILE LIST, and no file count. The roster spells out which files a
 *    session touched; here the map is already drawing them, as the rings around
 *    the orb. It's the one fact the card would be repeating.
 *  - IT CARRIES THE LAST MESSAGE. The roster summarises; this prints the words,
 *    below the fold, so sweeping four orbs tells her what all four actually
 *    said without opening anything. Catching up is what the map is for.
 *  - TWO ACTIONS, and only two: open HERE (this page becomes the
 *    conversation) or open THERE (the Observatory catches it, wherever one is
 *    watching — a tile in this window or another monitor's, via the window
 *    bus). Her words, and an honest fork the app used to decide silently. The
 *    roster's other controls (Stop, Approve/Deny, ✎, ×, Resume) are
 *    decisions, and a decision wants a surface that doesn't vanish when the
 *    mouse slips. The flag row's job here is triage — THIS orb needs you —
 *    and the open pair is the door to where it gets dealt with.
 *
 * Top to bottom it's a hierarchy of urgency rather than of source. Anything the
 * session is WAITING on (a question it raised, a command blocked at the gate, a
 * turn that died) goes first and wears colour. Then who it is, the housekeeping
 * line, and then the reading part: what she last asked, what it's working on,
 * what it last said.
 *
 * IT IS REACHABLE. Keep moving the cursor off the orb and into the card and it
 * stays put, wakes up, and becomes a thing she uses: the body scrolls (that's
 * how she reaches what it last said) and the footer goes solid. That makes this
 * a hovercard, not a tooltip — a preview surface you travel into, the way
 * GitHub's and Twitter's do. A tooltip must never take the pointer; a hovercard
 * has to.
 *
 * What makes the travel work is split across three files, because each part
 * belongs to a different owner:
 *  - the GRACE PERIOD, so crossing the gap between orb and card doesn't dismiss
 *    it, lives in TerrainPage (it owns the hover state);
 *  - the LIGHTING PIN, so the map keeps that agent's footprint lit while she's
 *    over the card and off the canvas, is `holdHover` in terrainCanvas.ts;
 *  - the geometry is agentHoverPlacement.ts (tested).
 * `onEngage` is how this file participates: it reports the pointer arriving and
 * leaving, and the page does the rest.
 *
 * Data comes from three places the app already had — the terrain payload (the
 * orb itself), the roster (SessionMeta: summary, model, spend, what it's
 * waiting on) and one small per-session fetch for the last line
 * (useSessionPreview). Every part renders only if its data is there, so a
 * session with nothing to say shows a small card rather than a scaffold of
 * blanks.
 *
 * Prompts that produced it: "if you keep going left over the popup it allows you
 * to hover over it and like, click a button. maybe even scroll down a bit in the
 * description" · "the same as the card on the front, and maybe showing my last
 * message into it, and then you can scroll down to see what it said last".
 */

/** The dot's six states, in the roster's own vocabulary. Same names, same
 * colours, decided by the same predicate (sessionFilters.cardState) — the point
 * of the exercise is that a colour means ONE thing across the whole app. Asking
 * and unread share the orange dot, exactly as the roster's cards do. */
const DOT_CLASS: Record<CardState, string> = {
  error: 'dotError',
  running: 'dotRunning',
  asking: 'dotUnread',
  unread: 'dotUnread',
  recent: 'dotRecent',
  rest: 'dotRest',
};

export interface AgentHoverFacts {
  /** From the terrain payload — always there, since the orb is on the map. */
  title: string;
  /** Which of the roster's five states this session is in, so the dot here and
   * the dot there can't disagree. Falls back to running-or-rest for a session
   * the roster doesn't know about (see TerrainPage). */
  state: CardState;
  /** The roster's card facts. Undefined until the roster query lands (or for a
   * session the roster doesn't know, e.g. one that's been archived since). */
  meta: SessionMeta | undefined;
  /** The last thing said, once the hover's own fetch returns. */
  preview: SessionPreview | undefined;
}

export function AgentHoverCard({
  hover,
  facts,
  engaged,
  onEngage,
  onOpenHere,
  onOpenThere,
}: {
  hover: AgentHover | null;
  facts: AgentHoverFacts | null;
  /** The cursor is inside the card — it's being read, not passed. */
  engaged: boolean;
  onEngage: (engaged: boolean) => void;
  /** Open this conversation on THIS page (the map navigates away to it). */
  onOpenHere: () => void;
  /** Hand it to the Observatory, wherever one is watching (see TerrainPage). */
  onOpenThere: () => void;
}) {
  if (!hover || !facts) return null;

  const { left, top } = hoverCardPlacement(hover, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const meta = facts.meta;
  // The three states that outrank everything else on the card, in the order
  // they outrank each other: a blocked command (she can't do anything until she
  // answers), a raised question, a turn that died.
  const blocked = meta?.awaiting_approval ?? null;
  const asking = meta?.awaiting_input ?? null;
  const failed = meta?.last_error ?? null;
  const line = cardMetaLine(meta);
  const asked = meta?.last_prompt?.trim() || '';
  const preview = facts.preview;
  // Don't print the same words twice. When she's sent something and nothing has
  // answered yet, the "last message" IS her message — and it's already up there
  // under "you asked", so the reply block simply has nothing to show.
  const said = preview?.text && preview.text.trim() !== asked ? preview.text : '';

  return createPortal(
    <div
      className={[styles.card, engaged ? styles.cardEngaged : ''].filter(Boolean).join(' ')}
      style={{ left, top }}
      onPointerEnter={(e) => {
        // Touch never gets here (the card is display:none on coarse pointers),
        // but a stray pen/touch pointer must not latch the card open.
        if (e.pointerType === 'mouse') onEngage(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') onEngage(false);
      }}
    >
      {blocked ? (
        <div className={[styles.flag, styles.flagOrange].join(' ')}>
          <span className={styles.flagLabel}>waiting for approval</span>
          <span className={styles.flagText}>{blocked.command || blocked.tool}</span>
        </div>
      ) : asking ? (
        <div className={[styles.flag, styles.flagOrange].join(' ')}>
          <span className={styles.flagLabel}>waiting on you</span>
          <span className={styles.flagText}>{asking}</span>
        </div>
      ) : failed ? (
        <div className={[styles.flag, styles.flagRed].join(' ')}>
          <span className={styles.flagLabel}>last turn failed</span>
          <span className={styles.flagText}>{failed}</span>
        </div>
      ) : null}

      <div className={styles.head}>
        {/* The roster's dot, with its whole vocabulary rather than just
            running-or-not: red broken, breathing violet working, orange unread,
            steady violet used-within-the-hour, grey at rest. This is what lets
            the map answer "which of these wants me" without going to the
            Observatory to find out. */}
        <span className={styles[DOT_CLASS[facts.state]]} aria-hidden="true" />
        <span className={styles.title}>{facts.title}</span>
        {meta?.pinned ? <span className={styles.badge}>pinned</span> : null}
        {meta?.draft ? <span className={styles.badge}>staged</span> : null}
      </div>
      {line ? <div className={styles.meta}>{line}</div> : null}

      {/* Who it is stays pinned above; what it SAID is the part that scrolls,
          so the card never loses its own name while she's reading down it.

          Keyed by session so React REMOUNTS it when the cursor moves to another
          orb. Without that it reuses the same node and carries its scrollTop
          across — scroll down one agent's reply, hover the next, and that card
          opens already scrolled, which reads as the top being cut off. */}
      <div key={hover.id} className={styles.body}>
        {/* Her ask, then what it made of it — cause above effect, the roster
            card's own order. Unlike the roster this prints at every state, not
            just while running or unread: on the map the question "what did I set
            this one going on?" is live for any orb she happens to point at, and
            the scroll means length costs nothing. */}
        {asked ? (
          <div className={styles.turn}>
            <div className={styles.turnLabel}>you asked</div>
            <div className={styles.askedText}>{asked}</div>
          </div>
        ) : null}

        {meta?.summary ? <div className={styles.summary}>{meta.summary}</div> : null}

        {/* The last thing it said — the part she scrolls to. Printed whole; the
            card's max-height does the cutting, so the fade at the bottom of the
            scroll region is the "keep going" cue. */}
        {said ? (
          <div className={styles.turn}>
            <div className={styles.turnLabel}>it said</div>
            <div className={styles.saidText}>{said}</div>
          </div>
        ) : preview?.private ? (
          <div className={styles.turn}>
            <div className={styles.turnLabel}>journal — not shown here</div>
          </div>
        ) : null}
      </div>

      {/* The open pair, her words: HERE = this page becomes the conversation,
          THERE = the Observatory catches it wherever one is watching. "There"
          wears the accent because it's the move that keeps the map up — the
          reason she's on the terrain at all. Both stay quiet until she's
          actually in the card, then go solid — a footer that shouted from
          across the map would make every sweep feel like a demand.

          Prompt: "i maybe want it to say 'open here' or 'open there' and
          'there' is the observatory and 'here' is that page". */}
      <div className={styles.actions}>
        <button
          type="button"
          className={[styles.openBtn, styles.openBtnQuiet].join(' ')}
          title="This page becomes the conversation"
          onClick={onOpenHere}
        >
          Open here
        </button>
        <button
          type="button"
          className={styles.openBtn}
          title="Open in the Observatory — this window's tile, or another monitor's"
          onClick={onOpenThere}
        >
          Open there
        </button>
      </div>
    </div>,
    document.body,
  );
}
