import { createPortal } from 'react-dom';
import type { SessionMeta, SessionPreview } from '../observatory/api';
import { lastActivityLabel } from '../observatory/sessionStatus';
import { formatSessionSpend } from '../observatory/turnStats';
import { hoverCardPlacement } from './agentHoverPlacement';
import type { AgentHover } from './terrainCanvas';
import styles from './AgentHoverCard.module.css';

/**
 * AgentHoverCard — put the cursor on an agent orb and the map tells you who it
 * is without you having to tap: the session's own card, floated beside the orb.
 *
 * What it prints, top to bottom, is a hierarchy of urgency rather than of
 * source. Anything the session is WAITING on (a question it raised, a command
 * blocked at the gate, a turn that died) goes first and wears colour. Then the
 * title, the housekeeping line the roster card already draws (model · when ·
 * spend · files), the cached one-line summary of what it's working on, and last
 * the actual last thing said in the conversation.
 *
 * IT IS REACHABLE. Keep moving the cursor off the orb and into the card and it
 * stays put, wakes up, and hands you two things it was only describing before:
 * the last message becomes scrollable (it's clamped and faded while she's only
 * passing by), and a footer appears that opens the session or rings its
 * footprint. That makes this a hovercard, not a tooltip — a preview surface you
 * travel into, the way GitHub's and Twitter's do. A tooltip must never take the
 * pointer; a hovercard has to.
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
 * Prompt that produced the reachable version: "i'm wondering if this feature
 * could be piped over into the hoverable popup that shows when you hover over
 * an agent. so if you keep going left over the popup it allows you to hover
 * over it and like, click a button. maybe even scroll down a bit in the
 * description."
 */

export interface AgentHoverFacts {
  /** From the terrain payload — always there, since the orb is on the map. */
  title: string;
  running: boolean;
  /** Files in its footprint on the CURRENT map, not lifetime. */
  files: number;
  /** The roster's card facts. Undefined until the roster query lands (or for a
   * session the roster doesn't know, e.g. one that's been archived since). */
  meta: SessionMeta | undefined;
  /** The last thing said, once the hover's own fetch returns. */
  preview: SessionPreview | undefined;
}

/** The housekeeping line — the same shape the roster card uses, plus what the
 * MAP knows that the roster doesn't (how many files are under this orb). Built
 * from whichever parts exist, so a fresh session shows nothing rather than a
 * row of separators. */
function metaLine(facts: AgentHoverFacts): string {
  return [
    facts.meta?.model_effective ?? null,
    lastActivityLabel(facts.meta?.last_at),
    facts.meta?.tokens ? formatSessionSpend(facts.meta.tokens) : null,
    facts.files > 0 ? `${facts.files} ${facts.files === 1 ? 'file' : 'files'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function AgentHoverCard({
  hover,
  facts,
  engaged,
  onEngage,
  onOpen,
  onFootprint,
  footprintOn,
}: {
  hover: AgentHover | null;
  facts: AgentHoverFacts | null;
  /** The cursor is inside the card — it's being read, not passed. */
  engaged: boolean;
  onEngage: (engaged: boolean) => void;
  /** Open this conversation (the left pane on desktop, see TerrainPage). */
  onOpen: () => void;
  /** Ring this agent's whole footprint on the map. */
  onFootprint: () => void;
  footprintOn: boolean;
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
  const line = metaLine(facts);
  const preview = facts.preview;

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
        {/* The breathing dot is the same signal the roster's busy state uses,
            so "this one is working" reads identically in both places. */}
        {facts.running ? <span className={styles.runningDot} /> : null}
        <span className={styles.title}>{facts.title}</span>
      </div>
      {line ? <div className={styles.meta}>{line}</div> : null}

      {/* Who it is stays pinned above; what it SAID is the part that scrolls,
          so the card never loses its own name while she's reading down it. */}
      <div className={styles.body}>
        {meta?.summary ? <div className={styles.summary}>{meta.summary}</div> : null}

        {preview?.text ? (
          <div className={styles.said}>
            <div className={styles.saidLabel}>
              {preview.role === 'user' ? 'you asked' : 'it said'}
            </div>
            {/* Clamped and faded while she's passing by; un-clamped the moment
                the cursor arrives, which costs no jump because the card's height
                is fixed — the text just keeps going into the scroll. */}
            <div className={styles.saidText}>{preview.text}</div>
          </div>
        ) : preview?.private ? (
          <div className={styles.said}>
            <div className={styles.saidLabel}>journal — not shown here</div>
          </div>
        ) : null}
      </div>

      {/* Quiet until she's actually in the card, then solid. A footer that
          shouted from across the map would make every sweep feel like a
          demand. */}
      <div className={styles.actions}>
        <button type="button" className={styles.openBtn} onClick={onOpen}>
          Open session
        </button>
        <button
          type="button"
          className={[styles.footprintBtn, footprintOn ? styles.footprintBtnOn : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={footprintOn}
          title="Ring this agent's files on the map"
          onClick={onFootprint}
        >
          Footprint
        </button>
      </div>
    </div>,
    document.body,
  );
}
