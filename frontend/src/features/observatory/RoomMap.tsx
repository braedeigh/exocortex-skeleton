/**
 * RoomMap.tsx — a room seen from above: every swarm as a circle, the helpers
 * in the middle, and the sessions working alone in rows underneath.
 *
 * What this is, in plain English: at the head of a room that has a room
 * helper (room_helper.py — the Coding room, for now), a collapsible card
 * draws the whole room at once:
 *
 *   - the ROOM HELPER on top, a filled dot like a swarm helper's: it sits a
 *     layer above the swarms and decides who works together. Tap it to open
 *     its chat, where every move it makes is posted with its reason and an
 *     undo line. Its last move is written beside it;
 *   - each SWARM in a circle, drawn exactly as on its own page
 *     (SwarmNetwork.tsx): purple rings for its sessions, green lines for who
 *     messaged whom, its helper in the middle. The swarm's name above the
 *     circle opens the swarm's page;
 *   - every session WORKING ALONE (in no swarm) in rows beneath, as the same
 *     rings, so a glance says who's out on their own.
 *
 * A ring's state follows the roster where the page has it (working glows,
 * an orange ring when it needs her), falling back to what the server said.
 * Tap any ring to open that session.
 *
 * Touches: swarmApi.ts (useRoomView — routes/swarms.py `room`), SwarmNetwork.tsx
 * (the circles, and the rings' look via SwarmNetwork.module.css),
 * body/CollapsibleCard.tsx (the card), RoomMap.module.css, SessionLane.tsx (which
 * puts this at the head of the room).
 *
 * Prompt that produced it: "There should also be a display on the front with
 * circles for each swarm and the generated helpers in the middle and extra
 * agents in rows below that. The swarms will be in the circles like they are
 * on each page."
 */
import { useNavigate } from '@tanstack/react-router';
import { CollapsibleCard } from '../body/CollapsibleCard';
import type { SessionMeta } from './api';
import styles from './RoomMap.module.css';
import ring from './SwarmNetwork.module.css';
import { SwarmNetwork, SwarmNetworkKey } from './SwarmNetwork';
import type { MemberState, RoomView, Swarm } from './swarmApi';
import { shortTitle } from './swarmNetworkMath';

/** A session's state, read from the roster the same way the swarm cards
 * read theirs: asking her beats working beats resting. */
function stateOf(meta: SessionMeta | undefined, fallback: MemberState): MemberState {
  if (!meta) return fallback;
  if (meta.awaiting_input) return 'needs_input';
  if (meta.running) return 'working';
  return 'silent';
}

/** One ring — the same drawing SwarmNetwork uses for a session. */
function Ring({ state, big = false }: { state: MemberState; big?: boolean }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={ring.ringBox} aria-hidden="true">
      {big ? null : <circle cx="16" cy="16" r="10" className={ring.ring} />}
      {state === 'needs_input'
        ? <circle cx="16" cy="16" r="14.5" className={ring.waitRing} />
        : <circle cx="16" cy="16" r="14" className={ring.halo} />}
      {state === 'working' ? <circle cx="16" cy="16" r={big ? 12 : 6.5} className={ring.spinner} /> : null}
      <circle cx="16" cy="16" r={big ? 9 : 3.5} className={ring.dot} />
    </svg>
  );
}

const MOVE_WORDS: Record<RoomView['moves'][number]['kind'], string> = {
  form: 'formed a swarm from',
  join: 'moved into a swarm:',
  split: 'split out of a swarm:',
  release: 'released to work alone:',
};

export function RoomMap({
  room,
  view,
  swarms,
  rosterById,
  onOpen,
}: {
  room: string;
  view: RoomView;
  /** The live swarms in this room. */
  swarms: Swarm[];
  /** Every session the page knows, for the rings' live state. */
  rosterById: Map<string, SessionMeta>;
  onOpen: (conv: string) => void;
}) {
  const navigate = useNavigate();
  const lastMove = view.moves.find((m) => !m.undone_at);
  const helperMeta = view.helper_conv ? rosterById.get(view.helper_conv) : undefined;

  return (
    <CollapsibleCard cardKey={`room-map-${room}`} title="The room from above" defaultOpen>
      <div className={styles.map}>
        {/* The room helper, above everything it arranges. */}
        {view.helper_conv ? (
          <div className={styles.top}>
            <button
              type="button"
              className={[styles.agent, styles.roomHelper, ring[`state_${stateOf(helperMeta, 'silent')}`]].join(' ')}
              onClick={() => onOpen(view.helper_conv!)}
              title="The room helper — tap to open its chat"
            >
              <Ring state={stateOf(helperMeta, 'silent')} big />
              <span className={styles.agentName}>Room helper</span>
            </button>
            {lastMove ? (
              <p className={styles.lastMove}>
                Last move: {MOVE_WORDS[lastMove.kind]} {lastMove.convs.length}{' '}
                {lastMove.convs.length === 1 ? 'session' : 'sessions'}
                {lastMove.to_swarm !== null ? ` (swarm ${lastMove.to_swarm})` : ''} — {lastMove.reason}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Each swarm in its circle, drawn as on its own page. */}
        {swarms.length > 0 ? (
          <>
            <SwarmNetworkKey />
            <div className={styles.circles}>
              {swarms.map((swarm) => (
                <div key={swarm.id} className={styles.swarm}>
                  <button
                    type="button"
                    className={styles.swarmName}
                    onClick={() =>
                      void navigate({ to: '/observatory/swarm/$swarmId', params: { swarmId: String(swarm.id) } })
                    }
                  >
                    {swarm.name} →
                  </button>
                  <div className={styles.circle}>
                    <SwarmNetwork
                      swarm={swarm}
                      onOpen={onOpen}
                      helperWorking={!!(swarm.helper_conv && rosterById.get(swarm.helper_conv)?.running)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className={styles.note}>No swarms in this room right now.</p>
        )}

        {/* Everyone working alone, in rows underneath. */}
        <h4 className={styles.soloHead}>Working alone</h4>
        {view.solos.length > 0 ? (
          <div className={styles.solos}>
            {view.solos.map((solo) => {
              const state = stateOf(rosterById.get(solo.conv), solo.state);
              return (
                <button
                  key={solo.conv}
                  type="button"
                  className={[styles.agent, ring[`state_${state}`]].join(' ')}
                  onClick={() => onOpen(solo.conv)}
                  title={solo.summary ? `${solo.title} — ${solo.summary}` : solo.title}
                >
                  <Ring state={state} />
                  <span className={styles.agentName}>{shortTitle(solo.title)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className={styles.note}>Nobody — every session here is in a swarm.</p>
        )}
      </div>
    </CollapsibleCard>
  );
}
