import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useSessionRoster } from '../../observatory/api';
import { sessionLocation } from '../../observatory/sessionLocation';
import { getFullOutput } from './api';
import {
  callStatus,
  formatDuration,
  isProblem,
  msBetween,
  readableInput,
  stallWarning,
  tally,
  type CallStatus,
  type CallStep,
  type Step,
} from './activityMath';
import { useActivityFeed } from './useActivityFeed';
import { TerrainRoomHeader } from '../TerrainRoomHeader';
import styles from './ActivityPage.module.css';

/**
 * ActivityPage — one session's work, step by step, as it happens
 * (/terrain/activity?agent=…, routes/terrain_.activity.tsx).
 *
 * The Observatory's session page shows the conversation: what she said and
 * what the agent replied. This is the layer underneath: every tool call with
 * its input and its output, the agent's asides between them, and the things
 * that explain a drop or a failure: a command that errored, an API retry, a
 * permission the classifier refused, a tool still going after four minutes,
 * a turn that ended in an error. It opens from the session toolbar's
 * "activity" button: beside the session on a wide screen, as its own page on
 * a phone.
 *
 * What it draws, top to bottom:
 * - the header: the Terrain rooms' shared one (TerrainRoomHeader), with the
 *   way back to the session beside its Rooms button;
 * - a status strip: running or idle, the counts (calls, failures, retries),
 *   and a stall warning when a running session has gone quiet;
 * - filter chips: everything, only tool calls, or only the problems;
 * - the steps. A tool call is one row: a status mark, the tool, what it
 *   acted on, how long it took. Tap it to fold or unfold its input and
 *   output. Outputs start unfolded, because watching them is the point.
 *
 * FOLLOW, the Workshop's rule: while she's at the bottom, new steps keep the
 * list scrolled to the newest. Scrolling up to read pauses that, and a pill
 * brings her back down. Reading beats following.
 *
 * The data comes from useActivityFeed.ts (polling, only new bytes each time)
 * and the logic from activityMath.ts (pairing, counts, stall rule, tested).
 *
 * Prompt that produced it: "i want something like the workshop, but for tool
 * call usage … a new button on an individual session … it opens the activity
 * of the session on the right hand side of the split screen or a page i can x
 * out of/go back on mobile … i want for all of the outputs to be visible as
 * it's working so that i can visualize what's going on and why things might
 * drop or fail."
 */

type Filter = 'all' | 'tools' | 'problems';

const STATUS_MARK: Record<CallStatus, string> = {
  running: '●',
  ok: '✓',
  error: '✗',
  denied: '⊘',
  'cut off': '◌',
};

/** "14:02:31" out of a local ISO stamp. */
function clockOf(at: string | null): string {
  return at && at.length >= 19 ? at.slice(11, 19) : '';
}

/** A step's own time, as a quiet label. */
function Time({ at }: { at: string | null }) {
  const text = clockOf(at);
  return text ? <span className={styles.time}>{text}</span> : null;
}

/** One tool call: a row that folds open to its input and output. */
function CallRow({
  call,
  convId,
  running,
  now,
  open,
  onToggle,
}: {
  call: CallStep;
  convId: string;
  running: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const status = callStatus(call, running);
  const [full, setFull] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // How long it took, or how long it's been going.
  let duration = '';
  if (call.result) duration = formatDuration(msBetween(call.at, call.result.at));
  else if (status === 'running') {
    const started = call.at ? Date.parse(call.at) : NaN;
    duration = Number.isNaN(started)
      ? call.elapsed !== null ? `${call.elapsed}s…` : '…'
      : `${formatDuration(Math.max(0, now - started))}…`;
  }

  // Fetch the uncut output, once, when she asks for it.
  const showAll = () => {
    setFetching(true);
    getFullOutput(convId, call.id)
      .then((res) => setFull(res.output))
      .catch(() => setFull(null))
      .finally(() => setFetching(false));
  };

  const output = full ?? call.result?.output ?? '';
  return (
    <li
      className={[styles.call, styles[`status_${status.replace(' ', '_')}`], call.parent ? styles.nested : '']
        .filter(Boolean)
        .join(' ')}
    >
      <button type="button" className={styles.callHead} aria-expanded={open} onClick={onToggle}>
        <span className={styles.mark} aria-label={status}>
          {STATUS_MARK[status]}
        </span>
        <span className={styles.toolName}>{call.name}</span>
        <span className={styles.target}>{call.target ?? ''}</span>
        <span className={styles.duration}>{duration}</span>
      </button>
      {open ? (
        <div className={styles.callBody}>
          <div className={styles.meta}>
            <Time at={call.at} />
            {call.parent ? <span>inside a subagent</span> : null}
            {status === 'cut off' ? <span>no output was ever written — the turn ended first</span> : null}
          </div>
          {call.denied ? (
            <p className={styles.problemText}>
              Refused{call.denied.reason ? ` — ${call.denied.reason}` : ''}
            </p>
          ) : null}
          {call.task ? (
            <p className={styles.metaLine}>
              Background task {call.task.status ?? ''}
              {call.task.text ? ` — ${call.task.text}` : ''}
            </p>
          ) : null}
          {call.input ? (
            <>
              <div className={styles.label}>input{call.inputCut ? ' (cut short)' : ''}</div>
              <pre className={styles.pre}>{readableInput(call)}</pre>
            </>
          ) : null}
          {call.result ? (
            <>
              <div className={styles.label}>
                output · {call.result.chars.toLocaleString()} characters
              </div>
              <pre className={[styles.pre, call.result.isError ? styles.preError : ''].filter(Boolean).join(' ')}>
                {output || '(empty)'}
              </pre>
              {call.result.outputCut && full === null ? (
                <button type="button" className={styles.smallBtn} onClick={showAll} disabled={fetching}>
                  {fetching ? 'Reading…' : `Show all ${call.result.chars.toLocaleString()} characters`}
                </button>
              ) : null}
            </>
          ) : status === 'running' ? (
            <p className={styles.metaLine}>Still running — output appears here when it finishes.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Everything that isn't a tool call: a line each, colored by what it means. */
function OtherRow({ step }: { step: Exclude<Step, CallStep> }) {
  const nested = 'parent' in step && step.parent ? styles.nested : '';
  switch (step.kind) {
    case 'prompt':
      return (
        <li className={[styles.line, styles.prompt].join(' ')}>
          <Time at={step.at} />
          <span className={styles.clamp}>You: {step.text}</span>
        </li>
      );
    case 'init':
      return (
        <li className={[styles.line, styles.quiet].join(' ')}>
          Turn started{step.model ? ` · ${step.model}` : ''}
        </li>
      );
    case 'said':
      return (
        <li className={[styles.line, styles.said, nested].filter(Boolean).join(' ')}>
          <span className={styles.clamp}>{step.text}</span>
        </li>
      );
    case 'thought':
      return (
        <li className={[styles.line, styles.quiet, nested].filter(Boolean).join(' ')}>
          <span className={styles.clamp}>thinking: {step.text}</span>
        </li>
      );
    case 'retry':
      return (
        <li className={[styles.line, styles.warn].join(' ')}>
          <Time at={step.at} />
          API retry {step.attempt ?? '?'}/{step.max ?? '?'} — {step.error ?? 'error'}
          {step.status ? ` (${step.status})` : ''}
          {step.delay_ms ? `, waiting ${formatDuration(step.delay_ms)}` : ''}
        </li>
      );
    case 'limit':
      return (
        <li className={[styles.line, styles.warn].join(' ')}>
          <Time at={step.at} />
          Rate limit {step.status}
          {step.window ? ` · ${step.window.replace('_', ' ')}` : ''}
        </li>
      );
    case 'end': {
      const bits = [
        step.duration_ms !== null ? formatDuration(step.duration_ms) : null,
        step.turns !== null ? `${step.turns} steps` : null,
        step.cost_usd ? `$${step.cost_usd.toFixed(2)}` : null,
      ].filter(Boolean);
      return (
        <li className={[styles.line, step.is_error ? styles.bad : styles.end].join(' ')}>
          <Time at={step.at} />
          <span>
            {step.is_error ? 'Turn failed' : 'Turn finished'}
            {step.is_error && step.reason ? ` — ${step.reason}` : ''}
            {bits.length ? ` · ${bits.join(' · ')}` : ''}
            {step.is_error && step.text ? <span className={styles.errorText}>{step.text}</span> : null}
          </span>
        </li>
      );
    }
    case 'error':
      return (
        <li className={[styles.line, styles.bad].join(' ')}>
          <Time at={step.at} />
          {step.text}
        </li>
      );
    case 'note':
      return <li className={[styles.line, styles.quiet].join(' ')}>system: {step.subtype}</li>;
    default:
      return null;
  }
}

/** Which sessions to offer when none is picked: running first, then newest. */
function SessionPicker({ onPick }: { onPick: (id: string) => void }) {
  const { data } = useSessionRoster(false);
  const sessions = useMemo(() => {
    const list = [...(data?.sessions ?? [])];
    list.sort((a, b) =>
      !!a.running !== !!b.running ? (a.running ? -1 : 1) : (b.last_at ?? '').localeCompare(a.last_at ?? ''),
    );
    return list.slice(0, 12);
  }, [data]);
  return (
    <div className={styles.chips} role="group" aria-label="Whose activity">
      {sessions.map((s) => (
        <button key={s.id} type="button" className={styles.chip} onClick={() => onPick(s.id)}>
          {s.running ? <span className={styles.chipDot} aria-label="working now" /> : null}
          {s.title}
        </button>
      ))}
    </div>
  );
}

export function ActivityPage({ agent }: { agent?: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const feed = useActivityFeed(agent);
  const { steps } = feed.state;

  // A clock for the "running for…" and "quiet for…" labels, ticking only
  // while something is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!feed.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [feed.running]);

  const [filter, setFilter] = useState<Filter>('all');
  const counts = useMemo(() => tally(steps, feed.running), [steps, feed.running]);
  const problems = useMemo(() => steps.filter((s) => isProblem(s, feed.running)).length, [steps, feed.running]);
  const shown = useMemo(() => {
    if (filter === 'tools') return steps.filter((s) => s.kind === 'call');
    if (filter === 'problems') return steps.filter((s) => isProblem(s, feed.running));
    return steps;
  }, [steps, filter, feed.running]);
  const quietMs = feed.lastGrowth === null ? null : Math.max(0, now - feed.lastGrowth);
  const stall = stallWarning(steps, feed.running, quietMs);

  // Folding: outputs start open. A row she tapped keeps her choice; the
  // fold-all switch clears those choices and sets the default.
  const [openByDefault, setOpenByDefault] = useState(true);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => choices[id] ?? openByDefault;
  const toggle = (id: string) => setChoices((cur) => ({ ...cur, [id]: !isOpen(id) }));
  const foldAll = (open: boolean) => {
    setOpenByDefault(open);
    setChoices({});
  };

  // Follow the newest step while she's at the bottom (see the header).
  const listRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    const list = listRef.current;
    if (follow && list) list.scrollTop = list.scrollHeight;
  }, [shown, follow]);
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (atBottom !== follow) setFollow(atBottom);
  };
  const jumpToNewest = () => {
    setFollow(true);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  };

  // Back to the session: the way she came if there is one (a phone that
  // opened this from the session), otherwise to the session itself.
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else if (agent) void navigate(sessionLocation(agent));
    else void navigate({ to: '/observatory' });
  };

  const pickAgent = (id: string) => void navigate({ to: '/terrain/activity', search: { agent: id } });

  return (
    <section className={styles.view} aria-label="Session activity — every step, live">
      {/* Two ways out: back to the session it was opened from, and the
          Rooms button every Terrain room shares. */}
      <TerrainRoomHeader
        title="Activity"
        sub={feed.title ?? (agent ? 'Loading…' : 'Every tool call, with its output.')}
      >
        <button type="button" className={styles.back} onClick={back} aria-label="Back to the session">
          ← Session
        </button>
      </TerrainRoomHeader>

      {!agent ? (
        <>
          <p className={styles.note}>Pick a session to watch.</p>
          <SessionPicker onPick={pickAgent} />
        </>
      ) : (
        <>
          <div className={styles.status}>
            <span className={[styles.liveDot, feed.running ? styles.liveOn : ''].filter(Boolean).join(' ')} />
            <span>{feed.running ? 'working' : 'idle'}</span>
            <span className={styles.count}>{counts.calls} calls</span>
            {counts.running > 0 ? <span className={styles.count}>{counts.running} running</span> : null}
            {counts.errors > 0 ? <span className={[styles.count, styles.countBad].join(' ')}>{counts.errors} failed</span> : null}
            {counts.denied > 0 ? <span className={[styles.count, styles.countBad].join(' ')}>{counts.denied} refused</span> : null}
            {counts.retries > 0 ? <span className={[styles.count, styles.countWarn].join(' ')}>{counts.retries} retries</span> : null}
          </div>
          {stall ? <p className={styles.stall}>{stall}</p> : null}
          {feed.error ? <p className={styles.stall}>Can&rsquo;t read the activity: {feed.error}</p> : null}

          <div className={styles.controls}>
            <div className={styles.chips} role="group" aria-label="Show">
              {(
                [
                  ['all', 'Everything'],
                  ['tools', 'Tool calls'],
                  ['problems', `Problems${problems ? ` (${problems})` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={[styles.chip, filter === key ? styles.chipOn : ''].filter(Boolean).join(' ')}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className={styles.chip} onClick={() => foldAll(!openByDefault)}>
              {openByDefault ? 'Fold all' : 'Unfold all'}
            </button>
          </div>

          <div className={styles.listWrap}>
            <div ref={listRef} className={styles.list} onScroll={onScroll}>
              {feed.clipped ? (
                <p className={styles.note}>A long session — this starts partway through, at its most recent hours.</p>
              ) : null}
              {feed.loaded && steps.length === 0 ? (
                <p className={styles.note}>Nothing yet. Steps appear here as the session works.</p>
              ) : null}
              <ol className={styles.steps}>
                {shown.map((step) =>
                  step.kind === 'call' ? (
                    <CallRow
                      key={step.key}
                      call={step}
                      convId={agent}
                      running={feed.running}
                      now={now}
                      open={isOpen(step.id)}
                      onToggle={() => toggle(step.id)}
                    />
                  ) : (
                    <OtherRow key={step.key} step={step} />
                  ),
                )}
              </ol>
            </div>
            {!follow ? (
              <button type="button" className={styles.followPill} onClick={jumpToNewest}>
                ↓ Newest
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
