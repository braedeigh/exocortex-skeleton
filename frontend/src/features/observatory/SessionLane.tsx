import { useNavigate } from '@tanstack/react-router';
import { type SessionMeta } from './api';
import { orchestraRows } from './orchestra';
import { ApprovalCard, AwaitingCard, SessionCard } from './SessionCard';
import { LaneHead, useLaneOpen } from './LaneHead';
import type { TerrainData } from '../terrain/api';
import styles from './SessionLane.module.css';

/**
 * SessionLane — one of the Observatory's three rooms: the title line, the
 * collapse, the urgency ordering, and the way back through the room's past.
 * The cards themselves live in SessionCard.tsx (split 08-03 — three renderers
 * and seven per-row state maps had grown inline here).
 *
 * WHY THIS EXISTS (her 07-27 call). The page used to render every session
 * twice: once in "My sessions" (the whole roster) and again in "Orchestra" (a
 * `running || awaiting` filter over that same roster), in two different visual
 * languages. So there was no way to say where anything *lived* — Orchestra was
 * a view, not a place. Now a session BELONGS to a lane, exclusively, and stays
 * put whether or not it happens to be working.
 *
 * The move that made it collapse: LIVE IS A STATE THE CARD WEARS, not a
 * section it migrates into. One card renders idle, breathing, waiting, and
 * blocked — so a Personal session shows the files it's touching exactly like
 * an Orchestra one, which the old split couldn't do at all.
 *
 * QUIET-UNTIL-ACTIVE, LOUD-WHEN-WAITING (Sunflower): a resting lane is still;
 * working cards breathe violet; cards that need her glow orange and float to
 * the top with the ask in her face — a request she has to walk past can't be a
 * whisper, or the queue becomes a graveyard (Terra).
 *
 * COLLAPSIBLE (her 08-03 ask). Three rooms of cards is a long page on a phone,
 * so each one shuts to its title line and remembers that. The census stays on
 * the HEADER, so a shut room still reports what's running and what's waiting —
 * see LaneHead.tsx, which owns that whole contract.
 *
 * PAST SESSIONS SIT UNDER THEIR OWN ROOM (her 08-03 ask, corrected: "be able
 * to see past sessions like, within a certain room underneath that room").
 * A room shows what's OPEN in it; the line beneath it is the way back through
 * everything that room has ever held, scoped to that room. It's a door, not a
 * drawer — it goes to /observatory/archive?lane=… where the whole record can
 * be scrolled and searched, because that's a reading surface and this is a
 * standing-and-scanning one. The scoping is the point of putting it here
 * rather than once at the bottom of the page: leaving Coding is a different
 * question from leaving Personal.
 *
 * Terrain is polled ONCE by the page and passed in, not fetched per lane —
 * three lanes must not mean three pollers hitting the same endpoint.
 */
export function SessionLane({
  laneKey,
  heading,
  blurb,
  keeper = false,
  sessions,
  terrain,
  opened,
  emptyNote,
  onOpen,
  onSetRead,
  onRename,
  onChanged,
  onClose,
}: {
  /** Which room this is — the key its open/shut state is remembered under, so
   * collapsing Coding doesn't also collapse Personal. */
  laneKey: string;
  heading: string;
  /** The Keeper's slot: one pinned session standing above the rooms, with no
   * title line and no collapse. Her 08-03 ask — the door to her day shouldn't
   * be something she can shut by accident, or something she has to remember
   * which room she filed it in. */
  keeper?: boolean;
  /** One line under the heading saying what this room IS — the lanes differ in
   * whether they stop and ask, which is invisible unless it's written down. */
  blurb: string;
  /** Every session assigned to this lane, already sorted by the page. */
  sessions: SessionMeta[];
  terrain: TerrainData | undefined;
  /** convId -> last-opened ISO stamp, for the unread accent. */
  opened: Record<string, string>;
  /** What to say when the lane is empty because a colour filter is ON, rather
   * than because there's nothing here. "Tap + to start one" would be a lie in
   * that case — she'd make a session to fill a room that isn't actually empty. */
  emptyNote?: string;
  onOpen: (convId: string) => void;
  /** Flip a card's read flag by hand (the dot button on the card). */
  onSetRead?: (convId: string, read: boolean) => void;
  onRename: (session: SessionMeta) => void;
  onChanged?: () => void;
  onClose: (convId: string) => void;
}) {
  const navigate = useNavigate();
  // The Keeper's slot is never shut — it has no chevron to shut it with. The
  // hook still runs (hooks can't be conditional) and its answer is simply
  // overruled, so a stale stored '0' can't hide the one card that must not
  // hide.
  const [laneOpen, toggleOpen] = useLaneOpen(laneKey);
  const open = keeper || laneOpen;
  const rows = orchestraRows(sessions, terrain);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Urgency order, top to bottom: a gated command needing her OK (nothing moves
  // until she taps) > waiting-on-her (a reply) > everything else, in lane order.
  const approvals = rows.filter((r) => r.pendingApproval);
  const waiting = rows.filter((r) => !r.pendingApproval && r.awaiting);
  const rest = rows.filter((r) => !r.pendingApproval && !r.awaiting);

  const needing = approvals.length + waiting.length;
  const running = rest.filter((r) => r.running).length;
  // Drives the memory poll's cadence: quick while a turn is moving so a start
  // is caught in a couple of seconds, slow when the room is at rest.
  const anyRunning = rows.some((r) => r.running);

  // The title line, built once because BOTH the open and the shut room render
  // it — shut, it's the entire section. One number in the heading and it's the
  // one that asks something of her, which is why the plain size only appears
  // once the room is closed: open, the cards say how many there are just by
  // being there; closed, the size is the only thing left to say.
  // The Keeper has no title line at all: it isn't a room, it's one card, and a
  // heading over a single card is a label telling her what she's already
  // looking at. The teal ring and the 🌙 badge on the card do that work.
  const head = keeper ? null : (
    <LaneHead heading={heading} open={open} onToggle={toggleOpen} wanting={needing > 0}>
      {needing > 0 ? (
        <span className={styles.waitCount}>
          {needing} need{needing === 1 ? 's' : ''} you
        </span>
      ) : running > 0 ? (
        <span className={styles.count}>{running} running</span>
      ) : !open && rows.length > 0 ? (
        <span className={styles.restCount}>
          {rows.length} {rows.length === 1 ? 'session' : 'sessions'}
        </span>
      ) : null}
    </LaneHead>
  );

  // Shut: the header IS the room. Everything the census promised is already on
  // that line, so nothing that wants her can hide behind the collapse.
  if (!open) {
    return (
      <section className={styles.orchestra} aria-label={heading}>
        {head}
      </section>
    );
  }

  const sectionClass = [styles.orchestra, keeper ? styles.keeperRoom : '']
    .filter(Boolean)
    .join(' ');

  return (
    <section className={sectionClass} aria-label={heading}>
      {head}
      {keeper ? null : <p className={styles.blurb}>{blurb}</p>}

      {rows.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden="true" />
          {emptyNote ?? 'Nothing here yet — tap + at the top right to start one.'}
        </div>
      ) : (
        <div className={styles.rows}>
          {approvals.map((row) => (
            <ApprovalCard key={row.id} row={row} onOpen={onOpen} onChanged={onChanged} />
          ))}

          {waiting.map((row) => (
            <AwaitingCard key={row.id} row={row} onOpen={onOpen} />
          ))}

          {rest.map((row) => {
            const meta = byId.get(row.id);
            if (!meta) return null;
            return (
              <SessionCard
                key={row.id}
                row={row}
                meta={meta}
                openedAt={opened[row.id]}
                live={anyRunning}
                onOpen={onOpen}
                onSetRead={onSetRead}
                onRename={onRename}
                onClose={onClose}
                onChanged={onChanged}
              />
            );
          })}
        </div>
      )}

      {/* The way back through this room. Under the cards, inside the collapse —
          it belongs to the room, so it goes when the room shuts.
          Not offered in the Keeper slot: that's one standing session, and
          "past Keepers" are rolled-over days that live in Personal's record.
          [prompt: "be able to see past sessions like, within a certain room
          underneath that room ... not within each chat session"] */}
      {keeper ? null : (
        <button
          type="button"
          className={styles.pastLink}
          onClick={() =>
            void navigate({ to: '/observatory/archive', search: { lane: laneKey } })
          }
        >
          Past sessions in {heading} →
        </button>
      )}
    </section>
  );
}
