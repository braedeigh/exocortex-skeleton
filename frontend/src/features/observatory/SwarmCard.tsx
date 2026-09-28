/**
 * SwarmCard.tsx — one swarm, as a single card in its room.
 *
 * What this is, in plain English: sessions that have messaged each other form
 * a swarm (swarms.py), and in the room they live in they're folded into this
 * one card instead of showing separately. It says the swarm's name (its helper
 * names it), the helper's one-paragraph summary, and how many members are
 * working, silent, or need her. Tapping it opens the swarm's page, where the
 * members show as the usual session cards and the helper's work is laid out.
 * Tapping one member's chip skips the swarm page and opens that session.
 *
 * It wears the same colours as a session card, by the same rule and from the
 * same stylesheet (SessionLane.module.css): orange when any member needs her
 * (a question or a command to approve), breathing purple when any is working,
 * grey at rest. The colours are read from the roster, not the server's swarm
 * list, so they match the session cards exactly (roomOrder.swarmView).
 * Finished members (marked done, archived, or handed on to a continuation)
 * aren't on the card at all, and the rest are chipped in the room's order:
 * asking first, then the others waiting on her, then working, each longest
 * wait first. A waiting member with a reply she hasn't read (or a failed turn)
 * is a grey chip with an orange dot.
 *
 * Chip prompt: "if I click on a button on the swarm card for an agent, it
 * takes me directly to that agent".
 *
 * Touches: roomOrder.ts (the view it draws), SessionLane.tsx (places it),
 * SwarmPage.tsx (where tapping goes), SwarmCard.module.css.
 *
 * Prompt that produced it: "i want all interacting agents to be identified and
 * grouped in the observatory in the coding section etc. into a 'swarm' with a
 * card showing a summary of sessions inside and what they're working on and
 * how many are working or silent or need input. and you have to click into it
 * to show the sessions in cards like they currently do ... same orange purple
 * grey activity scheme."
 */
import { useNavigate } from '@tanstack/react-router';
import laneStyles from './SessionLane.module.css';
import styles from './SwarmCard.module.css';
import { orderMembers, type SwarmView } from './roomOrder';

const CARD_CLASS = { needs_input: 'cardUnread', working: 'cardLive', silent: '' } as const;
const DOT_CLASS = { needs_input: 'readyDot', working: 'liveDot', silent: 'restDot' } as const;
const MEMBER_CLASS = { needs_input: 'memberNeeds', working: 'memberWorking', silent: 'memberSilent' } as const;

export function SwarmCard({ view, onOpen }: { view: SwarmView; onOpen: (convId: string) => void }) {
  const navigate = useNavigate();
  const { swarm, state, members } = view;
  const { working, silent, needs_input: needing } = view.counts;
  return (
    <div
      className={[laneStyles.card, CARD_CLASS[state] ? laneStyles[CARD_CLASS[state]] : '', styles.swarm]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className={styles.open}
        onClick={() => void navigate({ to: '/observatory/swarm/$swarmId', params: { swarmId: String(swarm.id) } })}
        title="Open this swarm"
      >
        <span className={styles.top}>
          <span className={laneStyles[DOT_CLASS[state]]} aria-hidden="true" />
          <span className={styles.badge}>Swarm</span>
          <span className={laneStyles.title}>{swarm.name}</span>
          <span className={styles.size}>{members.length} {members.length === 1 ? 'session' : 'sessions'}</span>
        </span>
        <span className={styles.counts}>
          {needing > 0 ? <span className={styles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
          <span className={styles.working}>{working} working</span>
          <span className={styles.silent}>{silent} silent</span>
        </span>
        {swarm.summary ? (
          <span className={styles.summary}>{swarm.summary}</span>
        ) : (
          <span className={styles.summaryPending}>The helper hasn&rsquo;t summarised this swarm yet.</span>
        )}
      </button>
      {/* One button per member, opening that session directly. They sit
          outside the card-wide button because buttons can't nest. */}
      <div className={styles.members}>
        {orderMembers(members).map((m) => (
          <button
            type="button"
            key={m.conv}
            className={[styles.member, styles[MEMBER_CLASS[m.state]]].join(' ')}
            onClick={() => onOpen(m.conv)}
            title={`Open ${m.title}`}
          >
            {m.unread && m.state !== 'needs_input' ? <span className={styles.unreadDot} aria-label="unread" /> : null}
            {m.title}
          </button>
        ))}
      </div>
    </div>
  );
}
