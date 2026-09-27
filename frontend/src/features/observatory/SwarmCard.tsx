/**
 * SwarmCard.tsx — one swarm, as a single card in its room.
 *
 * What this is, in plain English: sessions that have messaged each other form
 * a swarm (swarms.py), and in the room they live in they're folded into this
 * one card instead of showing separately. It says the swarm's name (its helper
 * names it), the helper's one-paragraph summary, and how many members are
 * working, silent, or need her. Tapping it opens the swarm's page, where the
 * members show as the usual session cards and the helper's work is laid out.
 *
 * It wears the same colours as a session card, by the same rule and from the
 * same stylesheet (SessionLane.module.css): orange when any member needs her,
 * breathing purple when any is working, grey at rest.
 *
 * Touches: swarmApi.ts (the data, swarmState), SessionLane.tsx (places it),
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
import { swarmState, type Swarm } from './swarmApi';

const CARD_CLASS = { needs_input: 'cardUnread', working: 'cardLive', silent: '' } as const;
const DOT_CLASS = { needs_input: 'readyDot', working: 'liveDot', silent: 'restDot' } as const;
const MEMBER_CLASS = { needs_input: 'memberNeeds', working: 'memberWorking', silent: 'memberSilent' } as const;

export function SwarmCard({ swarm }: { swarm: Swarm }) {
  const navigate = useNavigate();
  const state = swarmState(swarm);
  const { working, silent, needs_input: needing } = swarm.counts;
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
          <span className={styles.size}>{swarm.members.length} sessions</span>
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
        <span className={styles.members}>
          {swarm.members.map((m) => (
            <span key={m.conv} className={[styles.member, styles[MEMBER_CLASS[m.state]]].join(' ')}>
              {m.title}
            </span>
          ))}
        </span>
      </button>
    </div>
  );
}
