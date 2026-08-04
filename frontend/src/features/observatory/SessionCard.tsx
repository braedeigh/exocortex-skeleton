/**
 * SessionCard.tsx — the three kinds of card a room can hold, each its own
 * component with its OWN state: ApprovalCard (a gated command needing her
 * Approve/Deny), AwaitingCard (a session waiting on her answer), and
 * SessionCard (everything else — idle, breathing, broken). Until 08-03 all
 * three lived inline in SessionLane behind seven parallel per-row Record
 * maps (stopArmed/closeArmed/expanded/fork/sticky/deciding/…); keying the
 * state to the component instead lets each card carry plain booleans. Cards
 * are keyed by conversation id in the lane, so state sticks to its card
 * across polls exactly as the maps did.
 *
 * Shares SessionLane.module.css — the cards and the lane are one visual
 * language, and the stylesheet is named for it.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  approveConversation,
  denyConversation,
  forkConversation,
  stopConversation,
  streamSend,
  type SessionMeta,
} from './api';
import { resumeAfterDecision } from './resumeAfterDecision';
import type { OrchestraRow } from './orchestra';
import { cardMetaLine } from './sessionStatus';
import { cardState, matchesFilter, type CardState } from './sessionFilters';
import { SessionMemoryChip } from '../runqueue/SessionMemoryChip';
import styles from './SessionLane.module.css';

/* The card's whole visual vocabulary, in two tables. cardState says WHICH state
   (from the same predicates the rail's buttons use); these say what it LOOKS
   like. Adding a state is a row in each table and a rule in the stylesheet —
   never another branch buried in the markup.

   'rest' has no card class on purpose: a cold card is the plain card. */
const CARD_CLASS: Record<CardState, string> = {
  error: 'cardError',
  running: 'cardLive',
  unread: 'cardUnread',
  recent: 'cardRecent',
  rest: '',
};

const DOT_CLASS: Record<CardState, string> = {
  error: 'errorDot',
  running: 'liveDot',
  unread: 'readyDot',
  recent: 'recentDot',
  rest: 'restDot',
};

// What a resumed session is told. `--resume` hands it the whole conversation
// back, so this is a CUE, not context — and a deliberately cautious one: the
// turn died mid-flight, possibly halfway through an edit, and a blunt
// "continue" invites it to redo work it already did. Look first, then decide.
const RESUME_CUE =
  'That turn ended in an error. Check what state things are actually in before continuing.';

/** Needs her OK — a gated command the act-ask gate stopped. The exact command
 * in her face, an Approve (Once/Always toggle, Once default — the safest per
 * Terra) and a Deny. */
export function ApprovalCard({
  row,
  onOpen,
  onChanged,
}: {
  row: OrchestraRow;
  onOpen: (convId: string) => void;
  onChanged?: () => void;
}) {
  const [sticky, setSticky] = useState(false);
  const [deciding, setDeciding] = useState(false);
  // Set when a decision landed but the resume never got through, so the card
  // says so instead of looking like the tap did nothing (which is exactly how
  // this bug presented). Cleared when she taps again.
  const [decideErr, setDecideErr] = useState('');

  // Resume the blocked turn after she decides: her tap + this send IS the retry
  // (same transport as request_input). The turn runs detached server-side; the
  // roster poll shows it running again.
  // The resume text is what the AGENT sees (its retry cue). The `decision` is
  // what SHE sees: it makes the server log a "✓ Approved: <cmd>" line in the
  // transcript instead of a blank off-record gap.
  //
  // The send goes through resumeAfterDecision rather than straight out, because
  // the Approve card is raised the moment the gate blocks — i.e. while the agent
  // is still writing the last message of the turn it was told to stop. A resume
  // fired into that window hits the server's one-turn-at-a-time guard (409) and
  // used to be dropped on the floor, which is what made an approved session sit
  // there doing nothing. Now it waits for the turn to land and then sends.
  const resume = async (text: string, decision: { kind: 'approve' | 'deny'; command: string }) => {
    try {
      await resumeAfterDecision(() =>
        streamSend(row.id, text, { record: false, decision }, () => {}),
      );
    } catch (err) {
      // A decision she made that never reached the agent must be visible.
      setDecideErr(err instanceof Error ? err.message : 'could not resume the session');
      setDeciding(false);
    } finally {
      onChanged?.();
    }
  };

  const decide = (
    resolve: () => Promise<{ command: string }>,
    kind: 'approve' | 'deny',
    cue: string,
  ) => {
    setDeciding(true);
    setDecideErr('');
    resolve()
      .then((res) => resume(cue, { kind, command: res.command }))
      .catch((err: unknown) => {
        setDecideErr(err instanceof Error ? err.message : 'could not record that decision');
        setDeciding(false);
      });
  };

  const doApprove = () =>
    decide(
      () => approveConversation(row.id, sticky),
      'approve',
      'Approved — go ahead and retry that exact command now.',
    );

  const doDeny = () =>
    decide(
      () => denyConversation(row.id),
      'deny',
      "I've denied that command — don't run it. Find another way, or stop and tell me why.",
    );

  return (
    <div className={styles.approval}>
      <div className={styles.awaitTop}>
        <span className={styles.awaitDot} aria-hidden="true" />
        <span className={styles.title}>{row.title}</span>
        <button
          type="button"
          className={styles.openLink}
          onClick={() => onOpen(row.id)}
          title="Open this session"
        >
          open →
        </button>
      </div>
      <div className={styles.approvalLabel}>wants to run</div>
      <code className={styles.command}>{row.pendingApproval?.command}</code>
      <div className={styles.approvalActions}>
        <div className={styles.scopeToggle} role="group" aria-label="Approval scope">
          <button
            type="button"
            className={[styles.scopeBtn, !sticky ? styles.scopeOn : ''].filter(Boolean).join(' ')}
            aria-pressed={!sticky}
            onClick={() => setSticky(false)}
            title="Allow just this once"
          >
            Once
          </button>
          <button
            type="button"
            className={[styles.scopeBtn, sticky ? styles.scopeOn : ''].filter(Boolean).join(' ')}
            aria-pressed={sticky}
            onClick={() => setSticky(true)}
            title="Allow this command for the rest of the session"
          >
            Always
          </button>
        </div>
        <div className={styles.decideBtns}>
          <button type="button" className={styles.denyBtn} disabled={deciding} onClick={doDeny}>
            Deny
          </button>
          <button
            type="button"
            className={styles.approveBtn}
            disabled={deciding}
            onClick={doApprove}
          >
            {deciding ? 'Sending…' : sticky ? 'Approve · always' : 'Approve · once'}
          </button>
        </div>
      </div>
      {/* A decision that never reached the agent says so here. Silence was the
          whole bug: the tap looked accepted and nothing moved. */}
      {decideErr ? (
        <div className={styles.decideError} role="alert">
          Couldn’t resume this session — {decideErr}. Tap again.
        </div>
      ) : null}
    </div>
  );
}

/** Waiting on her — orange, question in her face, tap to answer. */
export function AwaitingCard({
  row,
  onOpen,
}: {
  row: OrchestraRow;
  onOpen: (convId: string) => void;
}) {
  return (
    <button
      type="button"
      className={styles.awaiting}
      onClick={() => onOpen(row.id)}
      title="Answer this session"
    >
      <div className={styles.awaitTop}>
        <span className={styles.awaitDot} aria-hidden="true" />
        <span className={styles.title}>{row.title}</span>
        <span className={styles.answerHint}>Answer →</span>
      </div>
      <div className={styles.question}>{row.awaiting}</div>
    </button>
  );
}

/** The lane's own card: the same object whether it's breathing or resting —
 * only the dot, the file list and the working-only controls (Stop, Fork)
 * change. */
export function SessionCard({
  row,
  meta,
  openedAt,
  live,
  onOpen,
  onSetRead,
  onRename,
  onClose,
  onChanged,
}: {
  row: OrchestraRow;
  meta: SessionMeta;
  /** Her last-opened stamp for this conversation, for the unread accent. */
  openedAt: string | undefined;
  /** Anything in the lane running — drives the memory chip's poll cadence. */
  live: boolean;
  onOpen: (convId: string) => void;
  onSetRead?: (convId: string, read: boolean) => void;
  onRename: (session: SessionMeta) => void;
  onClose: (convId: string) => void;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const [stopArmed, setStopArmed] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  // The full file list, open or shut. Deliberately NOT persisted: this is a
  // live view of work in flight, not a preference.
  const [filesOpen, setFilesOpen] = useState(false);
  // Fork state: 'forking' while it stages, 'done' once the take-over spinoff
  // exists, 'error' on failure.
  const [fork, setFork] = useState<'forking' | 'done' | 'error' | null>(null);
  // Resume state on a red card: 'sending' while the nudge goes out, or the
  // failure text if even the retry couldn't get through.
  const [resuming, setResuming] = useState<string | null>(null);

  // Tap a file to read it (her 07-27 ask). On desktop this lane lives in the
  // split's LEFT pane and the router owns the right one, so navigating to
  // /code opens the file beside the session that's writing it, without
  // disturbing the lane. On mobile there's no split and it's a normal page
  // move — back returns here.
  const openFile = (repo: string, path: string) => {
    void navigate({ to: '/code', search: { repo, path } });
  };

  // Tap "Resume session?" on a red card. Off the record AND operator: this is
  // control the app speaks on her behalf, not something she said — the same
  // class as a slash command. `operator` is what keeps the cue itself out of
  // the transcript (a plain off-record send is hers, and hers is kept now).
  // Routed through resumeAfterDecision because the conversation may still be
  // winding down, and a 409 there means "not yet", not "no".
  //
  // Nothing here clears the red: her send does that server-side (`last_error`
  // is popped before the new turn starts), and the roster poll brings the
  // cleared card back. One source of truth for the flag, which is the server.
  const doResume = () => {
    setResuming('sending');
    resumeAfterDecision(() =>
      streamSend(row.id, RESUME_CUE, { record: false, operator: true }, () => {}),
    )
      .then(() => {
        setResuming(null);
        onChanged?.();
      })
      .catch((err) =>
        setResuming(err instanceof Error ? err.message : 'could not resume the session'),
      );
  };

  const doFork = () => {
    setFork('forking');
    forkConversation(row.id)
      .then(() => {
        setFork('done');
        onChanged?.();
      })
      .catch(() => setFork('error'));
  };

  // What this card wears, decided by the SAME predicates as the rail's
  // coloured buttons (sessionFilters.cardState) — so a purple dot on a card
  // and the purple button's count are the one rule, written down once.
  // `unread` is pulled out separately because two other things below key off
  // it, and it must be the orange button's own definition, not a second one
  // drifting beside it.
  const state = cardState(meta, openedAt);
  const unread = matchesFilter(meta, openedAt, 'unread');

  const files =
    row.files.length === 0 ? null : (
      <>
        {/* The edited files are a drawer, shut by default: a card standing at
            rest says HOW MANY files it touched, not which. Six of them used to
            sit open on every card, so a lane of working sessions was mostly
            file paths. Opening shows all of them; the open list is
            height-capped and scrolls (.filesOpen), so even a sixty-file
            session can't push the lane off the screen.
            [prompt: "files that have been edited auto collapsed rather than
            showing all the time, with the option to open it up"] */}
        <button
          type="button"
          className={styles.filesToggle}
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <span
            className={[styles.filesArrow, filesOpen ? styles.filesArrowOpen : '']
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            &#9654;
          </span>
          {row.files.length === 1 ? '1 file edited' : `${row.files.length} files edited`}
        </button>
        {filesOpen ? (
          <ul className={[styles.files, styles.filesOpen].join(' ')}>
            {row.files.map((f) => (
              <li key={`${f.repo}:${f.path}`}>
                <button
                  type="button"
                  className={styles.file}
                  title={`Read ${f.repo}/${f.path}`}
                  onClick={() => openFile(f.repo, f.path)}
                >
                  <span className={styles.filePath}>{f.path}</span>
                  {f.creates > 0 ? <span className={styles.newBadge}>new</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );

  return (
    <div
      className={[
        styles.card,
        CARD_CLASS[state] ? styles[CARD_CLASS[state]] : '',
        // HUE IS STATE; the Keeper's teal is a RING, not a hue — see
        // .cardKeeper. Layering them is the whole point: the Keeper is still
        // allowed to be unread, running or broken, and it has to be able to
        // say so in the same colours as everything else.
        meta.pinned ? styles.cardKeeper : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.cardTop}>
        <button
          type="button"
          className={styles.open}
          onClick={() => onOpen(row.id)}
          title="Open this session"
        >
          <span className={styles[DOT_CLASS[state]]} aria-hidden="true" />
          <span className={styles.title}>{row.title}</span>
          {/* What this session is holding, right beside its name — or that
              it's waiting for room, or that it's just started and the figure
              hasn't landed. One slot, three mutually exclusive states; see
              SessionMemoryChip. `running` comes from the roster, which knows
              a turn started seconds before the /proc walk does. */}
          <SessionMemoryChip convId={row.id} running={row.running} live={live} />
          {/* "pinned" described the mechanism; this names the thing. The moon
              is the Keeper's mark already — it's the glyph on Roll over, the
              control that closes her day. */}
          {meta.pinned ? (
            <span className={styles.keeperBadge}>
              <span aria-hidden="true">&#x1F319;</span> Keeper
            </span>
          ) : null}
          {meta.draft ? <span className={styles.badge}>staged</span> : null}
          {row.running ? (
            <span className={styles.fileCount}>
              {row.fileCount === 0
                ? 'starting…'
                : `${row.fileCount} ${row.fileCount === 1 ? 'file' : 'files'}`}
            </span>
          ) : null}
        </button>
        {row.running ? (
          <button
            type="button"
            className={[styles.stopBtn, stopArmed ? styles.stopArmed : ''].filter(Boolean).join(' ')}
            aria-label={`Stop ${row.title}`}
            title="Stop this agent"
            onClick={() => {
              if (!stopArmed) {
                setStopArmed(true);
                return;
              }
              setStopArmed(false);
              stopConversation(row.id)
                .then(() => onChanged?.())
                .catch(() => {
                  /* a failed stop just leaves it running — the poll re-syncs */
                });
            }}
          >
            {stopArmed ? 'Sure?' : 'Stop'}
          </button>
        ) : null}
        {/* Read / unread, by hand. Opening a session is the only other way
            this flag ever moves, which left no way back: a card she opened,
            skimmed and meant to return to went quiet forever. Tapping the dot
            puts it back to orange — the roster's own "deal with this later".
            [prompt: "an option to unmark things as read somewhere"] */}
        {!row.running && onSetRead ? (
          <button
            type="button"
            className={styles.readBtn}
            aria-label={unread ? `Mark ${row.title} read` : `Mark ${row.title} unread`}
            title={unread ? 'Mark as read' : 'Mark as unread'}
            onClick={() => onSetRead(row.id, unread)}
          >
            <span
              className={[styles.readDot, unread ? styles.readDotUnread : ''].filter(Boolean).join(' ')}
              aria-hidden="true"
            />
          </button>
        ) : null}
        {/* SETTINGS IS ALWAYS REACHABLE, running or not. It used to be the
            other arm of the Stop conditional, so a session that was working —
            which includes the whole of its first boot — had no ✎ at all, and
            the Room picker lives behind it. That was a layout accident, not a
            rule: the settings route has no running guard and config is
            resolved per turn, so a room change simply takes effect on the
            NEXT turn and deliberately never moves where the session runs.
            [prompt: "when a session is 'booting' or starting its first run
            ... it also does not allow me to change the location of the
            session"] */}
        <button
          type="button"
          className={styles.editBtn}
          aria-label={`Rename ${row.title}`}
          title="Session settings"
          onClick={() => onRename(meta)}
        >
          ✎
        </button>
        {!row.running && !meta.pinned ? (
          <button
            type="button"
            className={[styles.closeBtn, closeArmed ? styles.closeArmed : ''].filter(Boolean).join(' ')}
            aria-label={`Close ${row.title}`}
            title="Close session"
            onClick={() => {
              if (!closeArmed) {
                setCloseArmed(true);
                return;
              }
              setCloseArmed(false);
              onClose(row.id);
            }}
          >
            {closeArmed ? 'Sure?' : '×'}
          </button>
        ) : null}
      </div>

      {/* What she asked, then what it made of it — cause above effect. Only
          while the session is WORKING or UNREAD: those are the two states
          where the question "what did I ask for?" is still live. Once she's
          read the reply the summary is the better artifact and this would
          just be a longer card. Everything about what's safe to show here was
          decided at send time (routes/observatory.py) — the card only picks
          the moment. */}
      {(row.running || unread) && meta.last_prompt ? (
        <div className={styles.lastPrompt}>{meta.last_prompt}</div>
      ) : null}
      {row.summary ? <div className={styles.summary}>{row.summary}</div> : null}
      {/* One quiet line of housekeeping — model, when it last did anything,
          what it has spent. Shared with the terrain map's hovercard
          (sessionStatus.cardMetaLine) so the same session reads identically
          in both places. [prompt: "show what model is running from a session"] */}
      {cardMetaLine(meta) ? <div className={styles.cardMeta}>{cardMetaLine(meta)}</div> : null}
      {/* Why it's red. Without the message the glow only says "something
          broke", which sends her into the session to find out what — the
          whole point of the card is to answer that from the lane. */}
      {row.error ? <div className={styles.errorNote}>{row.error}</div> : null}
      {/* One tap to put the session back on its feet. No confirm — it's a
          retry, not a destructive act.

          The LABEL tells the truth about what the tap does. With a stored
          claude session id, --resume hands the agent its whole history back
          and this really is a resume. Without one (the turn died before
          claude said anything), there is nothing to resume into and the tap
          starts a fresh agent that knows none of it — so it says "Try again"
          instead, rather than promising continuity it can't deliver. */}
      {row.error ? (
        <>
          <button
            type="button"
            className={styles.resumeBtn}
            disabled={resuming === 'sending'}
            onClick={doResume}
          >
            {resuming === 'sending'
              ? 'Resuming…'
              : meta.claude_session_id
                ? 'Resume session?'
                : 'Try again?'}
          </button>
          {resuming && resuming !== 'sending' ? (
            <div className={styles.errorNote}>{resuming}</div>
          ) : null}
        </>
      ) : null}
      {files}

      {/* Fork-the-work: offload a bloated long-runner. Only offered while
          it's actually working and has a surface to hand over. Take-over, not
          parallel — she stops this one, then opens the fork (no auto-navigate
          that would run both at once). */}
      {row.running && row.fileCount > 0 ? (
        fork === 'done' ? (
          <div className={styles.forkDone}>
            ✓ Forked into a fresh session. Stop this one first, so the two don&rsquo;t clobber
            each other.
          </div>
        ) : (
          <button
            type="button"
            className={styles.forkBtn}
            disabled={fork === 'forking'}
            onClick={doFork}
          >
            {fork === 'forking'
              ? 'Staging a fork…'
              : fork === 'error'
                ? 'Fork failed — tap to retry'
                : 'Fork this work into a fresh session'}
          </button>
        )
      ) : null}
    </div>
  );
}
