/**
 * SwarmDemoPage.tsx — one real swarm, frozen mid-work, that anyone can click
 * through.
 *
 * What this is, in plain English: the owner's portfolio shows what a swarm
 * looks like in the Observatory. The live swarm pages are hers alone, so
 * this page draws a frozen copy instead: one swarm as it stood at one
 * moment, kept in a file she read through before publishing
 * (scripts/freeze_swarm.py makes it, routes/swarm_demo.py serves it). It is
 * drawn the way a swarm stands in its room (SwarmStack.tsx), top to bottom:
 *
 *   1. the swarm's NAME, how many members need her / are working / are
 *      silent, and the helper's summary, cut to a few lines until a tap
 *      asks for all of it;
 *   2. the BUBBLE: the swarm as a network in a circle (SwarmNetwork.tsx).
 *      A member that was mid-turn at the frozen moment spins, as it did
 *      then. Tapping a ring opens that session's chat, tapping a line opens
 *      the messages behind it;
 *   3. a QUESTION CARD for every member that was waiting on her, folded to
 *      one line; a tap unfolds the questions. Nobody can answer them here;
 *   4. a LITTLE CARD for each of the other members; a tap opens its chat.
 *
 * A chat opens in a sheet over the page: what she typed, what the agent
 * said, the messages between agents and the questions it filed, up to the
 * frozen moment and no further. A session that was mid-turn says so at the
 * foot of its chat.
 *
 * Nothing here polls, writes or reads a live session. `?embed=1` is the
 * portfolio's card: the same page with no app chrome around it
 * (shell/embed.ts).
 *
 * Touches: routes/swarm_demo.py (the two reads), SwarmNetwork.tsx (the
 * bubble, and its key), roomOrder.ts (the members' order), events.ts (the
 * chat's turns), replyViews.tsx and QuestionsCard.tsx (drawing them),
 * SwarmStack.module.css, SessionLane.module.css, PeerCard.module.css and
 * ObservatoryPage.module.css (the real pages' own looks),
 * SwarmDemoPage.module.css, routes/demo.swarm.tsx (the route).
 *
 * Prompt that produced it: "i want to put like, a frozen demo of a swarm
 * that was working and make it clickable" · "a swarm cluster in the
 * observatory with like the description and dots and stuff" · "some of the
 * dots to be spinning to show what they look like when they're working" ·
 * "with question cards and everything. but like, make those expandable."
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Sheet } from '../../ui/Sheet';
import { questionsState, turnsFromHistory } from './events';
import chatStyles from './ObservatoryPage.module.css';
import peerStyles from './PeerCard.module.css';
import { QuestionsBlock } from './QuestionsCard';
import { Reply, UserMessage } from './replyViews';
import { orderMembers, swarmView } from './roomOrder';
import laneStyles from './SessionLane.module.css';
import { SummaryLines } from './SummaryLines';
import styles from './SwarmDemoPage.module.css';
import { SwarmNetwork, SwarmNetworkKey } from './SwarmNetwork';
import stackStyles from './SwarmStack.module.css';
import type { LineMessage, MemberState, Swarm } from './swarmApi';

/** One chat's card in the frozen file: no text, only what the stack shows. */
interface DemoSession {
  title: string;
  state: MemberState;
  retired: boolean;
  /** The questions it had open at the frozen moment. */
  questions: string[];
}

/** The frozen swarm (routes/swarm_demo.py). */
interface SwarmDemo {
  frozen_at: string;
  helper_working: boolean;
  swarm: Swarm;
  messages: LineMessage[];
  sessions: Record<string, DemoSession>;
}

interface DemoChat {
  id: string;
  title: string;
  state: MemberState;
  events: unknown[];
}

const STACK_CLASS = { needs_input: 'stackNeeds', working: 'stackWorking', silent: '' } as const;
const DOT_CLASS = { needs_input: 'readyDot', working: 'liveDot', silent: 'restDot' } as const;
const noTap = () => {};

/** The frozen moment in words: "Oct 2, 2026, 10:52 PM". */
function momentWords(at: string): string {
  const moment = new Date(at);
  if (Number.isNaN(moment.getTime())) return at;
  return moment.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function SwarmDemoPage({ embed = false }: { embed?: boolean }) {
  // Read the frozen swarm once. It never changes, so nothing polls.
  const { data: demo, isError } = useQuery({
    queryKey: ['swarm-demo'] as const,
    queryFn: ({ signal }) => api.get<SwarmDemo>('/api/demo/swarm', signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [wholeSummary, setWholeSummary] = useState(false);

  if (isError) return <p className={styles.note}>The frozen swarm isn&rsquo;t here right now.</p>;
  if (!demo) return null;

  const { swarm, sessions } = demo;
  // The members as a room shows them: finished ones left off the cards
  // (they stay in the bubble), in the room's order. There is no live roster
  // here, so each member's state is the one it was frozen with.
  const view = swarmView(swarm, new Map(), {});
  const ordered = orderMembers(view.members);
  const asking = ordered.filter((m) => (sessions[m.conv]?.questions.length ?? 0) > 0);
  const others = ordered.filter((m) => !asking.includes(m));
  const { working, silent, needs_input: needing } = view.counts;

  return (
    <div className={[styles.page, embed ? styles.embed : ''].filter(Boolean).join(' ')}>
      <p className={styles.frozen}>
        <span className={styles.frozenMark} aria-hidden="true">&#10052;</span>
        A real swarm, frozen at {momentWords(demo.frozen_at)}. Tap a dot to read that session&rsquo;s chat, a line
        to read the messages on it, a question card to unfold it.
      </p>

      <div className={[stackStyles.stack, STACK_CLASS[view.state] ? stackStyles[STACK_CLASS[view.state]] : '', styles.stack]
        .filter(Boolean).join(' ')}>
        {/* 1. What the swarm is: its name, counts, summary. */}
        <div className={stackStyles.head}>
          <div className={[stackStyles.name, styles.name].join(' ')}>
            <span className={laneStyles[DOT_CLASS[view.state]]} aria-hidden="true" />
            <span className={stackStyles.nameText}>{swarm.name}</span>
          </div>
          <div className={stackStyles.counts}>
            {needing > 0 ? <span className={stackStyles.needing}>{needing} need{needing === 1 ? 's' : ''} you</span> : null}
            <span className={stackStyles.working}>{working} working</span>
            <span>{silent} silent</span>
            <span>{view.members.length} {view.members.length === 1 ? 'session' : 'sessions'}</span>
          </div>
          {/* The summary, cut to a few lines until asked for, so the bubble
              is on screen when the page opens inside the portfolio's card. */}
          {swarm.summary ? (
            <>
              <p className={[stackStyles.summary, wholeSummary ? '' : styles.summaryCut].filter(Boolean).join(' ')}>
                <SummaryLines text={swarm.summary} />
              </p>
              <button
                type="button"
                className={[styles.openChat, styles.more].join(' ')}
                aria-expanded={wholeSummary}
                onClick={() => setWholeSummary(!wholeSummary)}
              >
                {wholeSummary ? 'Show less' : 'Read the helper\u2019s whole summary'}
              </button>
            </>
          ) : null}
        </div>

        {/* 2. The bubble: the swarm as a network, in its circle. */}
        <SwarmNetworkKey />
        <div className={stackStyles.circle}>
          <SwarmNetwork
            swarm={swarm}
            onOpen={setOpenChat}
            helperWorking={demo.helper_working}
            frozenMessages={demo.messages}
            round
          />
        </div>

        {/* 3. The questions its members were asking her, each folded to a line. */}
        {asking.length > 0 ? (
          <div className={stackStyles.questions}>
            {asking.map((m) => {
              const questions = sessions[m.conv].questions;
              const open = !!unfolded[m.conv];
              return (
                <div key={m.conv} className={styles.question}>
                  <button
                    type="button"
                    className={styles.questionHead}
                    aria-expanded={open}
                    onClick={() => setUnfolded((now) => ({ ...now, [m.conv]: !open }))}
                  >
                    <span className={[stackStyles.arrow, open ? stackStyles.arrowOpen : ''].filter(Boolean).join(' ')} aria-hidden="true">
                      &#9654;
                    </span>
                    <span className={laneStyles.readyDot} aria-hidden="true" />
                    <span className={styles.questionTitle}>{m.title}</span>
                    <span className={styles.questionCount}>
                      {questions.length} {questions.length === 1 ? 'question' : 'questions'}
                    </span>
                  </button>
                  {open ? (
                    <div className={styles.questionBody}>
                      <ol className={styles.questionList}>
                        {questions.map((question, index) => <li key={index}>{question}</li>)}
                      </ol>
                      <button type="button" className={styles.openChat} onClick={() => setOpenChat(m.conv)}>
                        Open this session&rsquo;s chat &rarr;
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* 4. A little card for each other live member; tap to open it. */}
        {others.length > 0 ? (
          <div className={stackStyles.members}>
            {others.map((m) => (
              <button
                key={m.conv}
                type="button"
                className={[stackStyles.member, stackStyles[`member_${m.state}`]].join(' ')}
                onClick={() => setOpenChat(m.conv)}
                title={`Open ${m.title}`}
              >
                <span className={stackStyles.memberTop}>
                  <span className={laneStyles[DOT_CLASS[m.state]]} aria-hidden="true" />
                  <span className={stackStyles.memberTitle}>{m.title}</span>
                </span>
                {m.summary ? <span className={stackStyles.memberSummary}>{m.summary}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <FrozenChat
        conv={openChat}
        title={openChat ? sessions[openChat]?.title ?? openChat : ''}
        frozenAt={demo.frozen_at}
        known={(conv) => conv in sessions}
        onOpen={setOpenChat}
        onClose={() => setOpenChat(null)}
      />
    </div>
  );
}

/** One session's chat, in a sheet: the turns a chat page draws, read-only.
 * Asked for only once a visitor opens it. */
function FrozenChat({
  conv,
  title,
  frozenAt,
  known,
  onOpen,
  onClose,
}: {
  conv: string | null;
  title: string;
  frozenAt: string;
  /** Whether a session is part of the demo, so its name can be a door. */
  known: (conv: string) => boolean;
  onOpen: (conv: string) => void;
  onClose: () => void;
}) {
  const { data: chat, isPending, isError } = useQuery({
    queryKey: ['swarm-demo-chat', conv] as const,
    enabled: conv !== null,
    queryFn: ({ signal }) => api.get<DemoChat>(`/api/demo/swarm/chat/${encodeURIComponent(conv!)}`, signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // Turn the kept events into turns with the chat page's own reducer.
  const turns = useMemo(() => turnsFromHistory(chat?.events ?? []), [chat]);

  return (
    <Sheet open={conv !== null} title={title} onClose={onClose} wide>
      {isPending ? <p className={styles.note}>Loading…</p> : null}
      {isError ? <p className={styles.note}>Couldn&rsquo;t load this chat.</p> : null}
      <div className={styles.chat}>
        {turns.map((t, i) => {
          if (t.silent) return null;
          if (t.role === 'user') {
            return <UserMessage key={i} index={i} text={t.text} offRecord={false} />;
          }
          if (t.role === 'reminder') {
            return (
              <div key={i} className={chatStyles.reminder}>
                <span className={chatStyles.reminderLabel}>
                  {t.source === 'wake' ? '◌ Room change · sent by the app' : '⚙ System · sent by the app'}
                </span>
                <span className={chatStyles.reminderText}>{t.text}</span>
              </div>
            );
          }
          if (t.role === 'questions' && t.questions) {
            return <QuestionsBlock key={i} questions={t.questions} state={questionsState(turns, i)} />;
          }
          if (t.role === 'peer' && t.peer) {
            // A message between two agents: the chat page's teal card. The
            // other session's name opens its chat when the demo holds it.
            const out = t.peer.direction === 'out';
            const name = t.peer.otherTitle || t.peer.otherConv;
            const other = t.peer.otherConv;
            return (
              <div key={i} className={peerStyles.card}>
                <div className={peerStyles.head}>
                  <span className={peerStyles.arrow} aria-hidden="true">{out ? '→' : '←'}</span>
                  <span className={peerStyles.label}>
                    {out ? 'Sent to ' : 'From '}
                    {known(other) ? (
                      <button type="button" className={peerStyles.who} onClick={() => onOpen(other)}>{name}</button>
                    ) : name}
                  </span>
                </div>
                <div className={peerStyles.text}>{t.text}</div>
              </div>
            );
          }
          if (t.role === 'error') {
            return <div key={i} className={chatStyles.error}>{t.text}</div>;
          }
          if (t.role !== 'assistant') return null;
          return (
            <Reply
              key={i}
              index={i}
              text={t.text}
              buffer=""
              open={false}
              tool={null}
              journaled={false}
              armed={false}
              onBodyTap={noTap}
              onJournalTap={noTap}
            />
          );
        })}
      </div>
      {/* Say where the chat stops, and whether it stopped mid-turn. */}
      {chat ? (
        <p className={styles.chatEnd}>
          {chat.state === 'working' ? <span className={laneStyles.liveDot} aria-hidden="true" /> : null}
          {chat.state === 'working'
            ? `Still working when this was frozen, ${momentWords(frozenAt)}.`
            : `Frozen here, ${momentWords(frozenAt)}.`}
        </p>
      ) : null}
    </Sheet>
  );
}
