/**
 * RoomHelperBand.tsx — the room helper, in one band at the very top of the
 * Observatory, on every screen size.
 *
 * What this is, in plain English: a room with a room helper (room_helper.py,
 * the Coding room today) has one session looking after the whole room. Its dot
 * used to sit in the room map, under every project box, so reaching it meant a
 * long scroll. Now it's the first thing on the page: its live dot, its name,
 * the roster's one line on what it's doing, and its last move with the reason.
 * Tap anywhere on the band to open its chat. On a phone it's one compact band
 * of about 60px; the rest of the phone page is unchanged.
 *
 * The helper shows once: RosterPage tells the room map it's up here, so the
 * room's own map leaves its dot out. Project helpers stay in their boxes. Where
 * there's no room helper this draws nothing, which covers the Journal's list
 * and the desktop app (RosterPage doesn't ask for it there at all).
 *
 * Pointing the mouse at it lights the helper's orb on the Terrain map, like
 * every other session on this page (shell/panels/agentHoverBus.ts).
 *
 * Touches: swarmApi.ts (useRoomView), RoomMap.tsx (the ring, the state rule and
 * the move's wording, shared), RosterPage.tsx and RosterMap.tsx (draw it first),
 * RoomHelperBand.module.css.
 *
 * Prompt that produced it: "i want the room helper to be at the top of the
 * observatory page."
 */
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import { laneLabel, toLane, type SessionMeta } from './api';
import { moveLine, Ring, stateOf } from './RoomMap';
import styles from './RoomHelperBand.module.css';
import ring from './SwarmNetwork.module.css';
import { useRoomView } from './swarmApi';

export function RoomHelperBand({
  room,
  rosterById,
  onOpen,
}: {
  room: string;
  /** Every session the page knows, for the helper's live state and summary. */
  rosterById: Map<string, SessionMeta>;
  onOpen: (convId: string) => void;
}) {
  const { data: view } = useRoomView(room);
  const conv = view?.helper_conv;
  if (!conv) return null;
  const meta = rosterById.get(conv);
  const state = stateOf(meta, 'silent');
  const lastMove = view.moves.find((move) => !move.undone_at);
  return (
    <button
      type="button"
      className={[styles.band, ring[`state_${state}`]].join(' ')}
      onClick={() => onOpen(conv)}
      {...agentPointerProps(conv)}
      title="The room helper — tap to open its chat"
    >
      <Ring state={state} big />
      <span className={styles.words}>
        <span className={styles.line}>
          <span className={styles.name}>Room helper · {laneLabel(toLane(room))}</span>
          {meta?.summary ? <span className={styles.summary}>{meta.summary}</span> : null}
        </span>
        {lastMove ? <span className={styles.move}>Last move: {moveLine(lastMove)}</span> : null}
      </span>
      <span className={styles.arrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
