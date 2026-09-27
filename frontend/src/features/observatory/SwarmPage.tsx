/**
 * SwarmPage.tsx — one swarm, opened: its sessions and everything its helper
 * sees and does.
 *
 * What this is, in plain English: a swarm is a group of sessions that have
 * messaged each other (swarms.py), with a helper — a Sonnet that names the
 * swarm, keeps a summary of every member and notices where their work
 * collides (swarm_helper.py). This page shows, top to bottom:
 *
 *   - the swarm's name, the helper's summary, and where members' work differs;
 *   - the member sessions as the usual session cards, same colours, same taps
 *     (SessionLane, told it's showing a swarm so it doesn't fold them again);
 *   - a box to talk to the helper, and a link to its own chat;
 *   - what the helper thinks each member is doing;
 *   - every message between members;
 *   - every helper run, each opening to show exactly what it was given and
 *     what it wrote back — the information it used, nothing hidden.
 *
 * Touches: swarmApi.ts (useSwarm, refreshSwarm), api.ts (the roster, sending
 * to the helper's mailbox, closing a session), SessionLane.tsx (the member
 * cards), sessionLocation.ts, routes/observatory_.swarm.$swarmId.tsx (the
 * route), SwarmPage.module.css, NightCrewPage.module.css (the page chrome).
 *
 * Prompt that produced it: "one helper per swarm. i want to be able to click
 * into it and see what information is being used by it and sent between
 * sessions and summaries and whatnot. could also have an input section."
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { closeConversation, sendToInbox, useSessionRoster } from './api';
import pageStyles from './NightCrewPage.module.css';
import { setConversationRead, openedMap } from './readReceipts';
import { sessionLocation } from './sessionLocation';
import { SessionLane } from './SessionLane';
import styles from './SwarmPage.module.css';
import { refreshSwarm, useSwarm } from './swarmApi';
import { useTerrain } from '../terrain/api';

export function SwarmPage({ swarmId }: { swarmId: number }) {
  const navigate = useNavigate();
  const { data: swarm, error, refetch } = useSwarm(swarmId);
  const anyWorking = (swarm?.counts.working ?? 0) > 0;
  const { data: roster, refetch: refetchRoster } = useSessionRoster(anyWorking);
  const { data: terrain } = useTerrain(anyWorking, 350);
  const [ask, setAsk] = useState('');
  const [note, setNote] = useState('');
  const [, bump] = useState(0);

  const open = (convId: string) => void navigate(sessionLocation(convId));
  const titleOf = (conv: string) =>
    swarm?.members.find((m) => m.conv === conv)?.title ?? (conv === swarm?.helper_conv ? 'Helper' : conv);

  // Her question to the helper goes to its mailbox like any message; the
  // helper answers in a run of its own, shown in its chat and below.
  const sendAsk = () => {
    const text = ask.trim();
    if (!text || !swarm?.helper_conv) return;
    sendToInbox(swarm.helper_conv, text, true).then(
      () => {
        setAsk('');
        setNote('Sent — the helper answers in its chat, and the run shows below.');
        void refetch();
      },
      () => setNote('Couldn’t send that — try again.'),
    );
  };

  const memberConvs = new Set(swarm?.members.map((m) => m.conv) ?? []);
  const memberSessions = (roster?.sessions ?? []).filter((s) => memberConvs.has(s.id));

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate({ to: '/observatory' })}>
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>{swarm ? swarm.name : 'Swarm'}</h1>
        </div>

        {error ? <p className={styles.empty}>Couldn&rsquo;t load this swarm.</p> : null}
        {swarm ? (
          <>
            {/* What the swarm is, in the helper's words. */}
            <section className={styles.section}>
              <div className={styles.countsRow}>
                <span className={styles.needing}>
                  {swarm.counts.needs_input > 0 ? `${swarm.counts.needs_input} need you · ` : ''}
                </span>
                <span>
                  {swarm.counts.working} working · {swarm.counts.silent} silent · {swarm.members.length} sessions
                </span>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() =>
                    void refreshSwarm(swarm.id).then(() => setNote('The helper is updating — give it a minute.'))
                  }
                >
                  Update summaries
                </button>
              </div>
              <p className={styles.summary}>{swarm.summary ?? 'The helper hasn’t summarised this swarm yet.'}</p>
              {swarm.differences.length > 0 ? (
                <div className={styles.differences}>
                  <h2 className={styles.h2}>Where their work differs or collides</h2>
                  <ul className={styles.list}>
                    {swarm.differences.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            {/* The members, as the usual cards. */}
            <SessionLane
              laneKey={`swarm-${swarm.id}`}
              swarmId={swarm.id}
              heading="Sessions"
              blurb="Every session in this swarm. Tap one to open it."
              sessions={memberSessions}
              terrain={terrain}
              opened={openedMap()}
              onOpen={open}
              onSetRead={(convId, read) => {
                setConversationRead(convId, read);
                bump((n) => n + 1);
              }}
              onRename={(s) => open(s.id)}
              onChanged={() => void refetchRoster()}
              onClose={(convId) => void closeConversation(convId).then(() => refetchRoster())}
            />

            {/* Talking to the helper. */}
            <section className={styles.section}>
              <h2 className={styles.h2}>Ask the helper</h2>
              <div className={styles.askRow}>
                <textarea
                  className={styles.ask}
                  value={ask}
                  placeholder="What's everyone doing? Is anyone stepping on anyone?"
                  onChange={(e) => setAsk(e.target.value)}
                  rows={2}
                />
                <button type="button" className={styles.button} onClick={sendAsk} disabled={!ask.trim()}>
                  Send
                </button>
              </div>
              {note ? <p className={styles.note}>{note}</p> : null}
              {swarm.helper_conv ? (
                <button type="button" className={styles.link} onClick={() => open(swarm.helper_conv!)}>
                  Open the helper&rsquo;s chat &rarr;
                </button>
              ) : null}
            </section>

            {/* What the helper thinks each member is doing. */}
            <section className={styles.section}>
              <h2 className={styles.h2}>What each session is doing</h2>
              <ul className={styles.list}>
                {swarm.members.map((m) => (
                  <li key={m.conv}>
                    <button type="button" className={styles.link} onClick={() => open(m.conv)}>
                      {m.title}
                    </button>
                    <span className={styles.muted}> — {m.summary ?? 'not summarised yet'}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Everything said between members (and the helper). */}
            <section className={styles.section}>
              <h2 className={styles.h2}>Messages between sessions</h2>
              {swarm.messages.length === 0 ? <p className={styles.muted}>None yet.</p> : null}
              <ul className={styles.messages}>
                {swarm.messages.map((m) => (
                  <li key={m.id} className={styles.message}>
                    <span className={styles.muted}>
                      {m.at.slice(5, 16).replace('T', ' ')} · {titleOf(m.from)} &rarr; {titleOf(m.to)}
                      {m.mode !== 'inject' ? ` · ${m.mode}` : ''}
                      {m.status === 'held' ? ' · held' : ''}
                    </span>
                    <span className={styles.messageText}>{m.text}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Every helper run, input and output verbatim. */}
            <section className={styles.section}>
              <h2 className={styles.h2}>What the helper read and wrote</h2>
              {swarm.runs.length === 0 ? <p className={styles.muted}>It hasn&rsquo;t run yet.</p> : null}
              {swarm.runs.map((r) => (
                <details key={r.id} className={styles.run}>
                  <summary className={styles.runHead}>
                    {r.at.slice(5, 16).replace('T', ' ')} · {r.trigger ?? 'run'}
                    {r.cost_usd != null ? ` · $${r.cost_usd.toFixed(3)}` : ''}
                    {r.error ? ' · failed' : ''}
                  </summary>
                  {r.error ? <p className={styles.error}>{r.error}</p> : null}
                  <h3 className={styles.h3}>It was given</h3>
                  <pre className={styles.pre}>{r.input}</pre>
                  <h3 className={styles.h3}>It wrote back</h3>
                  <pre className={styles.pre}>{r.output ? JSON.stringify(r.output, null, 2) : '—'}</pre>
                </details>
              ))}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
