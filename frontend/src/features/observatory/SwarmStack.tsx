/**
 * SwarmStack.tsx — one swarm in the room map, as a single column: what it
 * is, its bubble, the questions its members are asking her, then a small
 * card for each of its other members.
 *
 * What this is, in plain English: in a room with a room helper (RoomMap.tsx),
 * each swarm stands as one stack instead of a bubble up top and a separate
 * card further down the room. Top to bottom:
 *
 *   1. the swarm's NAME (tap it to open the swarm's page), how many members
 *      need her / are working / are silent, and the helper's summary;
 *   2. the BUBBLE: the swarm drawn as a network in a circle (SwarmNetwork.tsx);
 *   3. a QUESTION CARD for every member waiting on her: the same
 *      AwaitingCard / ApprovalCard as anywhere else in the room
 *      (SessionCard.tsx), so she answers right here;
 *   4. a LITTLE CARD for each of the other live members: its dot, its name,
 *      and the helper's line on what it's doing. Tap it to open that session.
 *
 * Members follow the room's order (roomOrder.orderMembers): asking first,
 * then the others waiting on her, then working, each longest wait first.
 * Finished members (done, archived, handed on) aren't in the view at all
 * (roomOrder.swarmView). Colours are the session cards' own: an orange edge
 * when anyone needs her, a breathing purple one when anyone works, grey at
 * rest, from SessionLane.module.css.
 *
 * Touches: RoomMap.tsx (draws one per swarm), roomOrder.ts (the view and the
 * member order), orchestra.ts (the rows the question cards read),
 * SessionCard.tsx (AwaitingCard, ApprovalCard), SwarmNetwork.tsx (the bubble),
 * SwarmStack.module.css, SessionLane.module.css (state colours and dots).
 *
 * Prompt that produced it: "currently, there is a card separate from each
 * little bubble where the swarm is. i want the summary of the swarm above the
 * little bubble and then i want the question cards to show below it in the
 * swarm and i want each one to have its little card below the swarm bubble"
 */
import { useNavigate } from '@tanstack/react-router';
import type { SessionMeta } from './api';
import { orchestraRows } from './orchestra';
import { orderMembers, type SwarmView } from './roomOrder';
import { ApprovalCard, AwaitingCard } from './SessionCard';
import laneStyles from './SessionLane.module.css';
import { SwarmNetwork } from './SwarmNetwork';
import styles from './SwarmStack.module.css';

const STACK_CLASS = { needs_input: 'stackNeeds', working: 'stackWorking', silent: '' } as const;
const DOT_CLASS = { needs_input: 'readyDot', working: 'liveDot', silent: 'restDot' } as const;

export function SwarmStack({
  view,
  rosterById,
  onOpen,
  onChanged,
}: {
  view: SwarmView;
  /** Every session the page knows: the members' live state and questions. */
  rosterById: Map<string, SessionMeta>;
  onOpen: (conv: string) => void;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const { swarm, state, members } = view;
  const { working, silent, needs_input: needing } = view.counts;

  // Split the members into question cards and little cards, in the room's
  // order. A member only gets a question card when the roster carries its
  // question; one the roster has lost stays a little card rather than an
  // empty question.
  const ordered = orderMembers(members);
  const metas = ordered.flatMap((m) => {
    const meta = rosterById.get(m.conv);
    return meta ? [meta] : [];
  });
  const rowById = new Map(orchestraRows(metas, undefined).map((row) => [row.id, row]));
  const asking = ordered.flatMap((m) => {
    const row = rowById.get(m.conv);
    return row && (row.pendingApproval || row.awaiting) ? [row] : [];
  });
  const askingIds = new Set(asking.map((row) => row.id));
  const others = ordered.filter((m) => !askingIds.has(m.conv));

  return (
    <div className={[styles.stack, STACK_CLASS[state] ? styles[STACK_CLASS[state]] : ''].filter(Boolean).join(' ')}>
      {/* 1. What the swarm is: its name (the way to its page), counts, summary. */}
      <div className={styles.head}>
        <button
          type="button"
          className={styles.name}
          onClick={() =>
            void navigate({ to: '/observatory/swarm/$swarmId', params: { swarmId: String(swarm.id) } })
          }
          title="Open this swarm's page"
        >
          <span className={laneStyles[DOT_CLASS[state]]} aria-hidden="true" />
          <span className={styles.nameText}>{swarm.name}</span>
          <span aria-hidden="true">→</span>
        </button>
        <div className={styles.counts}>
          {needing > 0 ? <span className={styles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
          <span className={styles.working}>{working} working</span>
          <span>{silent} silent</span>
          <span>{members.length} {members.length === 1 ? 'session' : 'sessions'}</span>
        </div>
        {swarm.summary ? (
          <p className={styles.summary}>{swarm.summary}</p>
        ) : (
          <p className={styles.summaryPending}>The helper hasn&rsquo;t summarised this swarm yet.</p>
        )}
      </div>

      {/* 2. The bubble: the swarm as a network, in its circle. */}
      <div className={styles.circle}>
        <SwarmNetwork
          swarm={swarm}
          onOpen={onOpen}
          helperWorking={!!(swarm.helper_conv && rosterById.get(swarm.helper_conv)?.running)}
          round
        />
      </div>

      {/* 3. The questions its members are asking her, answerable here. */}
      {asking.length > 0 ? (
        <div className={styles.questions}>
          {asking.map((row) =>
            row.pendingApproval ? (
              <ApprovalCard key={row.id} row={row} onOpen={onOpen} onChanged={onChanged} />
            ) : (
              <AwaitingCard key={row.id} row={row} onOpen={onOpen} onChanged={onChanged} />
            ),
          )}
        </div>
      ) : null}

      {/* 4. A little card for each other live member; tap to open it. */}
      {others.length > 0 ? (
        <div className={styles.members}>
          {others.map((m) => (
            <button
              key={m.conv}
              type="button"
              className={[styles.member, styles[`member_${m.state}`]].join(' ')}
              onClick={() => onOpen(m.conv)}
              title={`Open ${m.title}`}
            >
              <span className={styles.memberTop}>
                {/* An unread reply or a failed turn: a grey card, orange dot. */}
                <span
                  className={laneStyles[m.unread && m.state === 'silent' ? 'readyDot' : DOT_CLASS[m.state]]}
                  aria-hidden="true"
                />
                <span className={styles.memberTitle}>{m.title}</span>
              </span>
              {m.summary ? <span className={styles.memberSummary}>{m.summary}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
