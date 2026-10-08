/**
 * SwarmPage.tsx — one swarm, opened: its sessions and everything its helper
 * sees and does.
 *
 * What this is, in plain English: a swarm is a group of sessions that have
 * messaged each other (swarms.py), with a helper — a Sonnet that names the
 * swarm, keeps a summary of every member and notices where their work
 * collides (swarm_helper.py). This page shows, top to bottom:
 *   - a box to ask the helper about the swarm's work, a link to its own
 *     chat (the helper is a session of its own) and one to its context page
 *     (HelperContextPage.tsx);
 *   - the swarm's name, the helper's summary, and where members' work differs;
 *   - once the swarm has closed, what it did: the closing summary its helper
 *     wrote, with the closing check (what git and the session records show)
 *     folded beneath it, and any earlier closings below that;
 *   - the swarm as a network: rings joined by green lines where members have
 *     messaged each other (SwarmNetwork.tsx), the helper as the dot in the middle;
 *   - a '+' on the Sessions title line that starts a new session inside the
 *     swarm — a member from its first turn (swarms.join), told on waking
 *     which swarm it's in and who else is working;
 *   - the member sessions as the usual session cards, same colours, same taps
 *     and the same order: waiting on her first (orange, then opened, each
 *     longest wait on top), then running, then done and handed-on ones with
 *     the most recently finished last (SessionLane, told it's showing a swarm
 *     so it doesn't fold them again). The counts at the top leave the done
 *     ones out (roomOrder.swarmView);
 *   - what the helper thinks each member is doing;
 *   - every message between members;
 *   - every helper run, each opening to show exactly what it was given and
 *     what it wrote back — the information it used, nothing hidden.
 *
 * Touches: swarmApi.ts (useSwarm, refreshSwarm), journal/markdown.ts (drawing
 * the closing summary), roomOrder.ts (swarmView), api.ts (the roster, sending
 * to the helper's mailbox, starting and closing a session), SessionDialog.tsx
 * (the new-session sheet), SessionLane.tsx (the member
 * cards), sessionLocation.ts, routes/observatory_.swarm.$swarmId.tsx (the
 * route), SwarmPage.module.css, NightCrewPage.module.css (the page chrome).
 *
 * Prompt that produced it: "one helper per swarm. i want to be able to click
 * into it and see what information is being used by it and sent between
 * sessions and summaries and whatnot. could also have an input section."
 * · "i want to make it possible to add a session per swarm room"
 * · "when a swarm retires, i want a summary of what was done ... so i can
 * know what was completed and ask it questions about what happened"
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  closeConversation,
  createSession,
  sendToInbox,
  toLane,
  updateConversation,
  useSessionRoster,
} from './api';
import pageStyles from './NightCrewPage.module.css';
import { setConversationRead, openedMap } from './readReceipts';
import { sessionLocation } from './sessionLocation';
import { SessionDialog, type SessionDraft } from './SessionDialog';
import { SessionLane } from './SessionLane';
import styles from './SwarmPage.module.css';
import { SwarmNetwork, SwarmNetworkKey } from './SwarmNetwork';
import { refreshSwarm, useSwarm } from './swarmApi';
import { swarmView } from './roomOrder';
import { useTerrain } from '../terrain/api';
import { mdToHtml } from '../journal/markdown';
import { SummaryLines } from './SummaryLines';

export function SwarmPage({ swarmId }: { swarmId: number }) {
  const navigate = useNavigate();
  const { data: swarm, error, refetch } = useSwarm(swarmId);
  const anyWorking = (swarm?.counts.working ?? 0) > 0;
  const { data: roster, refetch: refetchRoster } = useSessionRoster(anyWorking);
  const { data: terrain } = useTerrain(anyWorking, 350);
  const [ask, setAsk] = useState('');
  const [note, setNote] = useState('');
  const [, bump] = useState(0);
  const [creating, setCreating] = useState(false);

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
        setNote('Sent — the helper answers in its chat, and the run shows at the bottom.');
        void refetch();
      },
      () => setNote('Couldn’t send that — try again.'),
    );
  };

  // Start a session inside this swarm: the same sheet as a room's '+', opened
  // on the swarm's own room, and the new session joins the swarm on creation.
  // An explicit asks-first choice is a second call, as on the roster.
  const onCreate = (draft: SessionDraft) => {
    if (!swarm) return;
    return createSession(draft.name, draft.journal, draft.model, draft.lane, swarm.id).then(
      ({ id }) => {
        setCreating(false);
        if (draft.actGate !== null) void updateConversation(id, { act_gate: draft.actGate }).catch(() => {});
        void refetch();
        open(id);
      },
      () => setNote('Couldn’t start that session — try again.'),
    );
  };

  // The live members, read through the roster: the counts at the top by the
  // session cards' own rule, done and retired members left out of them.
  const opened = openedMap();
  const view = swarm
    ? swarmView(swarm, new Map((roster?.sessions ?? []).map((s) => [s.id, s])), opened)
    : null;
  // Every member still on the roster, done ones included: the lane sinks
  // them to the bottom (roomOrder.ts) rather than this page hiding them.
  const memberConvs = new Set(swarm?.members.map((m) => m.conv) ?? []);
  const liveConvs = new Set(view?.members.map((m) => m.conv) ?? []);
  const memberSessions = (roster?.sessions ?? []).filter((s) => memberConvs.has(s.id));
  const helperWorking = !!roster?.sessions.find((s) => s.id === swarm?.helper_conv)?.running;

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
        {/* A closed swarm (fewer than two sessions still at work) is hidden from the rooms;
            its page still opens, and says so. */}
        {swarm?.closed ? (
          <p className={styles.muted}>
            Closed — fewer than two sessions in this swarm are still at work. It opens again if a second one starts working,
            or a new session joins.
          </p>
        ) : null}
        {swarm && view ? (
          <>
            {/* Talking to the helper, first thing on the page: ask it about the
                swarm's work. It's a session of its own (swarm_helper.py). */}
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
              {swarm.helper_conv ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() =>
                    void navigate({ to: '/observatory/context/$convId', params: { convId: swarm.helper_conv! } })
                  }
                >
                  What the helper is working from, and your rules for it &rarr;
                </button>
              ) : null}
            </section>

            {/* What the swarm is, in the helper's words. */}
            <section className={styles.section}>
              <div className={styles.countsRow}>
                <span className={styles.needing}>
                  {view.counts.needs_input > 0 ? `${view.counts.needs_input} need you · ` : ''}
                </span>
                <span>
                  {view.counts.working} working · {view.counts.silent} silent · {view.members.length} sessions
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
              <p className={styles.summary}>
                {swarm.summary ? <SummaryLines text={swarm.summary} /> : 'The helper hasn’t summarised this swarm yet.'}
              </p>
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

            {/* What the swarm did, once it has closed: the helper's closing
                summary, newest first. mdToHtml escapes the text before it
                marks it up, so the model's words can't carry markup in. */}
            {swarm.closings && swarm.closings.length > 0 ? (
              <section className={styles.section}>
                <h2 className={styles.h2}>What this swarm did</h2>
                {swarm.closings.map((c, n) => (
                  <div key={c.id} className={styles.closing}>
                    <p className={styles.muted}>
                      {n === 0 ? 'Closed' : 'Closed earlier,'} {c.at.slice(0, 16).replace('T', ' ')}. Written by its
                      helper; ask it above about what happened.
                    </p>
                    {c.summary ? (
                      <div className={styles.closingBody} dangerouslySetInnerHTML={{ __html: mdToHtml(c.summary) }} />
                    ) : (
                      <p className={styles.error}>
                        No summary was written ({c.error ?? 'the model call failed'}). The closing check below is what
                        git shows.
                      </p>
                    )}
                    <details className={styles.run}>
                      <summary className={styles.runHead}>The closing check: what git and the session records show</summary>
                      <div className={styles.closingBody} dangerouslySetInnerHTML={{ __html: mdToHtml(c.facts) }} />
                    </details>
                  </div>
                ))}
              </section>
            ) : null}

            {/* Who's talking to whom, as a network. */}
            <section className={styles.section}>
              <h2 className={styles.h2}>Who&rsquo;s talking to whom</h2>
              <SwarmNetworkKey />
              <SwarmNetwork swarm={swarm} onOpen={open} helperWorking={helperWorking} />
            </section>

            {/* The members, as the usual cards. */}
            <SessionLane
              laneKey={`swarm-${swarm.id}`}
              swarmId={swarm.id}
              heading="Sessions"
              blurb="Every session in this swarm. Tap one to open it."
              sessions={memberSessions}
              terrain={terrain}
              onNew={() => setCreating(true)}
              opened={opened}
              onOpen={open}
              onSetRead={(convId, read) => {
                setConversationRead(convId, read);
                bump((n) => n + 1);
              }}
              onRename={(s) => open(s.id)}
              onChanged={() => void refetchRoster()}
              onClose={(convId) => void closeConversation(convId).then(() => refetchRoster())}
            />

            <SessionDialog
              open={creating}
              title={`New session in ${swarm.name}`}
              lane={toLane(swarm.lane)}
              modelChoices={roster?.model_choices ?? []}
              onClose={() => setCreating(false)}
              onSave={onCreate}
            />

            {/* What the helper thinks each member is doing. */}
            <section className={styles.section}>
              <h2 className={styles.h2}>What each session is doing</h2>
              <ul className={styles.list}>
                {/* Done and retired members last, so the live work reads first. */}
                {[...swarm.members]
                  .sort((a, b) => Number(!liveConvs.has(a.conv)) - Number(!liveConvs.has(b.conv)))
                  .map((m) => (
                  <li key={m.conv}>
                    <button type="button" className={styles.link} onClick={() => open(m.conv)}>
                      {m.title}
                    </button>
                    {/* Its summary's labelled lines, each on a line of its own under the title. */}
                    {m.summary ? (
                      <span className={styles.memberSummary}><SummaryLines text={m.summary} /></span>
                    ) : (
                      <span className={styles.muted}> — not summarised yet</span>
                    )}
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
