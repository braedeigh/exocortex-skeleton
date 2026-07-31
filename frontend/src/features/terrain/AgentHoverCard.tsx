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
 * blocked at the gate, a turn that died) goes first and wears colour — a card
 * she can hover past has no business whispering that. Then the title, the
 * housekeeping line the roster card already draws (model · when · spend ·
 * files), the cached one-line summary of what it's working on, and last the
 * actual last thing said in the conversation.
 *
 * It is deliberately UNREACHABLE — `pointer-events: none` all the way through.
 * A hovercard you can move the mouse into has to solve "the cursor left the orb
 * but entered the card", and there's nothing in here to click anyway: tapping
 * the orb already opens the session. So it never takes the pointer, and it can
 * never get stuck open.
 *
 * Data comes from three places the app already had — the terrain payload (the
 * orb itself), the roster (SessionMeta: summary, model, spend, what it's
 * waiting on) and one small per-session fetch for the last line
 * (useSessionPreview). Every part renders only if its data is there, so a
 * session with nothing to say shows a small card rather than a scaffold of
 * blanks.
 *
 * Prompt that produced it: "if you scroll up close and hover over an agent, it
 * shows a hovering popup with the last message and the summary and card
 * information."
 *
 * Where it lands beside the orb is pure geometry, and lives (tested) in
 * agentHoverPlacement.ts.
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
}: {
  hover: AgentHover | null;
  facts: AgentHoverFacts | null;
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
    <div className={styles.card} style={{ left, top }} aria-hidden="true">
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

      {meta?.summary ? <div className={styles.summary}>{meta.summary}</div> : null}

      {preview?.text ? (
        <div className={styles.said}>
          <div className={styles.saidLabel}>
            {preview.role === 'user' ? 'you asked' : 'it said'}
          </div>
          {/* Clamped, with the fade below doing the "there's more" work — an
              ellipsis on a five-line block reads as damage, a fade reads as
              depth. */}
          <div className={styles.saidText}>{preview.text}</div>
        </div>
      ) : preview?.private ? (
        <div className={styles.said}>
          <div className={styles.saidLabel}>journal — not shown here</div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
