import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  approveConversation,
  denyConversation,
  forkConversation,
  stopConversation,
  streamSend,
  type Lane,
  type SessionMeta,
} from './api';
import { resumeAfterDecision } from './resumeAfterDecision';
import { orchestraRows, type OrchestraRow } from './orchestra';
import { lastActivityLabel, sessionStatus } from './sessionStatus';
import { formatSessionSpend } from './turnStats';
import type { TerrainData } from '../terrain/api';
import styles from './Orchestra.module.css';

/**
 * SessionLane — one of the Observatory's two rooms, and the only place a
 * session card is drawn.
 *
 * WHY THIS EXISTS (her 07-27 call). The page used to render every session
 * twice: once in "My sessions" (the whole roster) and again in "Orchestra" (a
 * `running || awaiting` filter over that same roster), in two different visual
 * languages. So there was no way to say where anything *lived* — Orchestra was
 * a view, not a place. Now a session BELONGS to a lane, exclusively, and stays
 * put whether or not it happens to be working.
 *
 * The move that made it collapse: LIVE IS A STATE THE CARD WEARS, not a
 * section it migrates into. One card renders idle, breathing, waiting, and
 * blocked — so a Personal session shows the files it's touching exactly like
 * an Orchestra one, which the old split couldn't do at all.
 *
 * QUIET-UNTIL-ACTIVE, LOUD-WHEN-WAITING (Sunflower): a resting lane is still;
 * working cards breathe violet; cards that need her glow orange and float to
 * the top with the ask in her face — a request she has to walk past can't be a
 * whisper, or the queue becomes a graveyard (Terra).
 *
 * Terrain is polled ONCE by the page and passed in, not fetched per lane —
 * two lanes must not mean two pollers hitting the same endpoint.
 */

/** The card's housekeeping line: "opus[1m] · 4m ago · 18.2k tokens · $4.21".
 * Built from whichever parts exist, so a fresh session shows nothing rather
 * than a row of blanks and separators. Recomputed per render, which is what
 * keeps the "4m ago" honest as the roster polls.
 *
 * The model leads it. `model_effective` is the resolved answer — the session's
 * own pin if it has one, otherwise the CLI default the server looked up — so
 * this reads as "what it runs on" and not "what she happened to override",
 * which for most sessions would be nothing at all.
 * [prompt: "show what model is running from a session"] */
function cardMeta(meta: SessionMeta): string {
  return [
    meta.model_effective ?? null,
    lastActivityLabel(meta.last_at),
    meta.tokens ? formatSessionSpend(meta.tokens) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SessionLane({
  lane,
  heading,
  blurb,
  sessions,
  terrain,
  opened,
  emptyNote,
  onOpen,
  onSetRead,
  onNew,
  onRename,
  onChanged,
  onClose,
}: {
  lane: Lane;
  heading: string;
  /** One line under the heading saying what this room IS — the lanes differ in
   * whether they stop and ask, which is invisible unless it's written down. */
  blurb: string;
  /** Every session assigned to this lane, already sorted by the page. */
  sessions: SessionMeta[];
  terrain: TerrainData | undefined;
  /** convId -> last-opened ISO stamp, for the unread accent. */
  opened: Record<string, string>;
  /** What to say when the lane is empty because a colour filter is ON, rather
   * than because there's nothing here. "Tap + to start one" would be a lie in
   * that case — she'd make a session to fill a room that isn't actually empty. */
  emptyNote?: string;
  onOpen: (convId: string) => void;
  /** Flip a card's read flag by hand (the dot button on the card). */
  onSetRead?: (convId: string, read: boolean) => void;
  onNew: (lane: Lane) => void;
  onRename: (session: SessionMeta) => void;
  onChanged?: () => void;
  onClose: (convId: string) => void;
}) {
  const navigate = useNavigate();
  const rows = orchestraRows(sessions, terrain);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Tap a file to read it (her 07-27 ask). On desktop this lane lives in the
  // split's LEFT pane and the router owns the right one, so navigating to
  // /code opens the file beside the session that's writing it, without
  // disturbing the lane. On mobile there's no split and it's a normal page
  // move — back returns here.
  const openFile = (repo: string, path: string) => {
    void navigate({ to: '/code', search: { repo, path } });
  };

  const [stopArmed, setStopArmed] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState<string | null>(null);
  // Which cards have their full file list open. Deliberately NOT persisted:
  // this is a live view of work in flight, not a preference.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-row fork state: 'forking' while it stages, 'done' once the take-over
  // spinoff exists, 'error' on failure.
  const [fork, setFork] = useState<Record<string, 'forking' | 'done' | 'error'>>({});
  // Per-row approval UI state: the Once/Always toggle (default Once — the
  // safest per Terra) and whether a decision is mid-flight.
  const [sticky, setSticky] = useState<Record<string, boolean>>({});
  const [deciding, setDeciding] = useState<Record<string, boolean>>({});
  // Set when a decision landed but the resume never got through, so the card
  // says so instead of looking like the tap did nothing (which is exactly how
  // this bug presented). Cleared when she taps again.
  const [decideErr, setDecideErr] = useState<Record<string, string>>({});
  // Per-row resume state on a red card: 'sending' while the nudge goes out, or
  // the failure text if even the retry couldn't get through.
  const [resuming, setResuming] = useState<Record<string, string>>({});

  // What a resumed session is told. `--resume` hands it the whole conversation
  // back, so this is a CUE, not context — and a deliberately cautious one: the
  // turn died mid-flight, possibly halfway through an edit, and a blunt
  // "continue" invites it to redo work it already did. Look first, then decide.
  const RESUME_CUE =
    'That turn ended in an error. Check what state things are actually in before continuing.';

  // Tap "Resume session?" on a red card. Off the record: this is operator
  // control, not something she said — the same class as a slash command.
  // Routed through resumeAfterDecision because the conversation may still be
  // winding down, and a 409 there means "not yet", not "no".
  //
  // Nothing here clears the red: her send does that server-side (`last_error`
  // is popped before the new turn starts), and the roster poll brings the
  // cleared card back. One source of truth for the flag, which is the server.
  const doResume = (id: string) => {
    setResuming((r) => ({ ...r, [id]: 'sending' }));
    resumeAfterDecision(() => streamSend(id, RESUME_CUE, { record: false }, () => {}))
      .then(() => {
        setResuming((r) => {
          const next = { ...r };
          delete next[id];
          return next;
        });
        onChanged?.();
      })
      .catch((err) =>
        setResuming((r) => ({
          ...r,
          [id]: err instanceof Error ? err.message : 'could not resume the session',
        })),
      );
  };

  const doFork = (id: string) => {
    setFork((f) => ({ ...f, [id]: 'forking' }));
    forkConversation(id)
      .then(() => {
        setFork((f) => ({ ...f, [id]: 'done' }));
        onChanged?.();
      })
      .catch(() => setFork((f) => ({ ...f, [id]: 'error' })));
  };

  // Resume the blocked turn after she decides: her tap + this send IS the retry
  // (same transport as request_input). The turn runs detached server-side; the
  // roster poll shows it running again.
  // The resume text is what the AGENT sees (its retry cue). The optional
  // `decision` is what SHE sees: it makes the server log a "✓ Approved: <cmd>"
  // line in the transcript instead of a blank off-record gap. Both approve and
  // deny carry the exact command the routes hand back.
  //
  // The send goes through resumeAfterDecision rather than straight out, because
  // the Approve card is raised the moment the gate blocks — i.e. while the agent
  // is still writing the last message of the turn it was told to stop. A resume
  // fired into that window hits the server's one-turn-at-a-time guard (409) and
  // used to be dropped on the floor, which is what made an approved session sit
  // there doing nothing. Now it waits for the turn to land and then sends.
  const resume = async (
    id: string,
    text: string,
    decision?: { kind: 'approve' | 'deny'; command: string },
  ) => {
    try {
      await resumeAfterDecision(() =>
        streamSend(id, text, { record: false, decision }, () => {}),
      );
    } catch (err) {
      // A decision she made that never reached the agent must be visible.
      setDecideErr((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : 'could not resume the session',
      }));
      setDeciding((d) => ({ ...d, [id]: false }));
    } finally {
      onChanged?.();
    }
  };

  const decide = (
    id: string,
    resolve: () => Promise<{ command: string }>,
    kind: 'approve' | 'deny',
    cue: string,
  ) => {
    setDeciding((d) => ({ ...d, [id]: true }));
    setDecideErr((e) => ({ ...e, [id]: '' }));
    resolve()
      .then((res) => resume(id, cue, { kind, command: res.command }))
      .catch((err: unknown) => {
        setDecideErr((e) => ({
          ...e,
          [id]: err instanceof Error ? err.message : 'could not record that decision',
        }));
        setDeciding((d) => ({ ...d, [id]: false }));
      });
  };

  const doApprove = (id: string) =>
    decide(
      id,
      () => approveConversation(id, sticky[id] === true),
      'approve',
      'Approved — go ahead and retry that exact command now.',
    );

  const doDeny = (id: string) =>
    decide(
      id,
      () => denyConversation(id),
      'deny',
      "I've denied that command — don't run it. Find another way, or stop and tell me why.",
    );

  // Urgency order, top to bottom: a gated command needing her OK (nothing moves
  // until she taps) > waiting-on-her (a reply) > everything else, in lane order.
  const approvals = rows.filter((r) => r.pendingApproval);
  const waiting = rows.filter((r) => !r.pendingApproval && r.awaiting);
  const rest = rows.filter((r) => !r.pendingApproval && !r.awaiting);

  const needing = approvals.length + waiting.length;
  const running = rest.filter((r) => r.running).length;

  // The edited files are a drawer, shut by default: a card standing at rest
  // says HOW MANY files it touched, not which. Six of them used to sit open on
  // every card, so a lane of working sessions was mostly file paths and she had
  // to scroll past them to reach the next card. Now the count is the whole
  // resting state and the list is one tap away.
  //
  // Opening shows all of them rather than the old first-six-then-more: the
  // drawer already does the job the cap was doing (keeping a resting card
  // short), and an open list is height-capped and scrolls (.filesOpen), so even
  // a sixty-file session can't push the lane off the screen.
  // [prompt: "files that have been edited auto collapsed rather than showing
  // all the time, with the option to open it up"]
  const renderFiles = (row: OrchestraRow) => {
    if (row.files.length === 0) return null;
    const open = expanded[row.id] === true;
    return (
      <>
        <button
          type="button"
          className={styles.filesToggle}
          aria-expanded={open}
          onClick={() => setExpanded((e) => ({ ...e, [row.id]: !open }))}
        >
          <span
            className={[styles.filesArrow, open ? styles.filesArrowOpen : ''].filter(Boolean).join(' ')}
            aria-hidden="true"
          >
            &#9654;
          </span>
          {row.files.length === 1 ? '1 file edited' : `${row.files.length} files edited`}
        </button>
        {open ? (
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
  };

  return (
    <section className={styles.orchestra} aria-label={heading}>
      <div className={styles.head}>
        <h2 className={styles.heading}>{heading}</h2>
        {needing > 0 ? (
          <span className={styles.waitCount}>
            {needing} need{needing === 1 ? 's' : ''} you
          </span>
        ) : running > 0 ? (
          <span className={styles.count}>{running} running</span>
        ) : null}
        <button
          type="button"
          className={styles.newInLane}
          onClick={() => onNew(lane)}
          title={`New ${heading} session`}
          aria-label={`New ${heading} session`}
        >
          +
        </button>
      </div>
      <p className={styles.blurb}>{blurb}</p>

      {rows.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden="true" />
          {emptyNote ?? 'Nothing here yet — tap + to start one.'}
        </div>
      ) : (
        <div className={styles.rows}>
          {/* Needs her OK — a gated command the act-ask gate stopped. The exact
              command in her face, an Approve (Once/Always) and a Deny. */}
          {approvals.map((row) => (
            <div key={row.id} className={styles.approval}>
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
                    className={[styles.scopeBtn, sticky[row.id] !== true ? styles.scopeOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={sticky[row.id] !== true}
                    onClick={() => setSticky((s) => ({ ...s, [row.id]: false }))}
                    title="Allow just this once"
                  >
                    Once
                  </button>
                  <button
                    type="button"
                    className={[styles.scopeBtn, sticky[row.id] === true ? styles.scopeOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={sticky[row.id] === true}
                    onClick={() => setSticky((s) => ({ ...s, [row.id]: true }))}
                    title="Allow this command for the rest of the session"
                  >
                    Always
                  </button>
                </div>
                <div className={styles.decideBtns}>
                  <button
                    type="button"
                    className={styles.denyBtn}
                    disabled={deciding[row.id]}
                    onClick={() => doDeny(row.id)}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    className={styles.approveBtn}
                    disabled={deciding[row.id]}
                    onClick={() => doApprove(row.id)}
                  >
                    {deciding[row.id]
                      ? 'Sending…'
                      : sticky[row.id] === true
                        ? 'Approve · always'
                        : 'Approve · once'}
                  </button>
                </div>
              </div>
              {/* A decision that never reached the agent says so here. Silence
                  was the whole bug: the tap looked accepted and nothing moved. */}
              {decideErr[row.id] ? (
                <div className={styles.decideError} role="alert">
                  Couldn’t resume this session — {decideErr[row.id]}. Tap again.
                </div>
              ) : null}
            </div>
          ))}

          {/* Waiting on her — orange, question in her face, tap to answer. */}
          {waiting.map((row) => (
            <button
              key={row.id}
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
          ))}

          {/* Everything else: the lane's own cards. Same object whether it's
              breathing or resting — only the dot, the file list and the
              working-only controls (Stop, Fork) change. */}
          {rest.map((row) => {
            const meta = byId.get(row.id);
            if (!meta) return null;
            const status = sessionStatus(meta, opened[row.id]);
            return (
              <div
                key={row.id}
                // Three states, in strict precedence: broken beats busy beats
                // unread. A card can honestly be more than one of these at
                // once (a failed turn is also unread activity), and stacking
                // their glows would just muddy both — so the most urgent
                // truth is the one the card wears.
                className={[
                  styles.card,
                  row.error ? styles.cardError : row.running ? styles.cardLive : '',
                  !row.error && !row.running && status === 'ready' ? styles.cardUnread : '',
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
                    {/* Same precedence the card's glow uses: broken, busy,
                        unread, resting. */}
                    {row.error ? (
                      <span className={styles.errorDot} aria-hidden="true" />
                    ) : row.running ? (
                      <span className={styles.liveDot} aria-hidden="true" />
                    ) : status === 'ready' ? (
                      <span className={styles.readyDot} aria-hidden="true" />
                    ) : (
                      <span className={styles.restDot} aria-hidden="true" />
                    )}
                    <span className={styles.title}>{row.title}</span>
                    {meta.pinned ? <span className={styles.badge}>pinned</span> : null}
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
                      className={[styles.stopBtn, stopArmed === row.id ? styles.stopArmed : '']
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={`Stop ${row.title}`}
                      title="Stop this agent"
                      onClick={() => {
                        if (stopArmed !== row.id) {
                          setStopArmed(row.id);
                          return;
                        }
                        setStopArmed(null);
                        stopConversation(row.id)
                          .then(() => onChanged?.())
                          .catch(() => {
                            /* a failed stop just leaves it running — the poll re-syncs */
                          });
                      }}
                    >
                      {stopArmed === row.id ? 'Sure?' : 'Stop'}
                    </button>
                  ) : (
                    <>
                      {/* Read / unread, by hand. Opening a session is the only
                          other way this flag ever moves, which left no way back:
                          a card she opened, skimmed and meant to return to went
                          quiet forever. Tapping the dot puts it back to orange —
                          the roster's own "deal with this later".
                          [prompt: "an option to unmark things as read
                          somewhere"] */}
                      {onSetRead ? (
                        <button
                          type="button"
                          className={styles.readBtn}
                          aria-label={
                            status === 'ready'
                              ? `Mark ${row.title} read`
                              : `Mark ${row.title} unread`
                          }
                          title={status === 'ready' ? 'Mark as read' : 'Mark as unread'}
                          onClick={() => onSetRead(row.id, status === 'ready')}
                        >
                          <span
                            className={[
                              styles.readDot,
                              status === 'ready' ? styles.readDotUnread : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.editBtn}
                        aria-label={`Rename ${row.title}`}
                        title="Session settings"
                        onClick={() => onRename(meta)}
                      >
                        ✎
                      </button>
                      {!meta.pinned ? (
                        <button
                          type="button"
                          className={[styles.closeBtn, closeArmed === row.id ? styles.closeArmed : '']
                            .filter(Boolean)
                            .join(' ')}
                          aria-label={`Close ${row.title}`}
                          title="Close session"
                          onClick={() => {
                            if (closeArmed !== row.id) {
                              setCloseArmed(row.id);
                              return;
                            }
                            setCloseArmed(null);
                            onClose(row.id);
                          }}
                        >
                          {closeArmed === row.id ? 'Sure?' : '×'}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                {/* What it's working on, then which files. The summary was
                    already on the roster payload — the live card just never
                    showed it, so a working session said WHICH files but never
                    WHAT FOR. */}
                {/* What she asked, then what it made of it — cause above
                    effect. Only while the session is WORKING or UNREAD: those
                    are the two states where the question "what did I ask for?"
                    is still live. Once she's read the reply the summary is the
                    better artifact and this would just be a longer card.
                    Everything about what's safe to show here was decided at
                    send time (routes/observatory.py) — the card only picks the
                    moment. */}
                {(row.running || status === 'ready') && meta.last_prompt ? (
                  <div className={styles.lastPrompt}>{meta.last_prompt}</div>
                ) : null}
                {row.summary ? <div className={styles.summary}>{row.summary}</div> : null}
                {/* One quiet line of housekeeping: when it last did anything
                    (last_at moves on both her send and the turn's finish), and
                    what it has spent. Either half can be missing — a session
                    with no finished turn has no spend, a never-run one has no
                    stamp — so they're joined only where both exist and the
                    line disappears entirely when neither does. */}
                {cardMeta(meta) ? <div className={styles.cardMeta}>{cardMeta(meta)}</div> : null}
                {/* Why it's red. Without the message the glow only says
                    "something broke", which sends her into the session to find
                    out what — the whole point of the card is to answer that
                    from the lane. */}
                {row.error ? <div className={styles.errorNote}>{row.error}</div> : null}
                {/* One tap to put the session back on its feet. No confirm —
                    it's a retry, not a destructive act.

                    The LABEL tells the truth about what the tap does. With a
                    stored claude session id, --resume hands the agent its whole
                    history back and this really is a resume. Without one (the
                    turn died before claude said anything), there is nothing to
                    resume into and the tap starts a fresh agent that knows
                    none of it — so it says "Try again" instead, rather than
                    promising continuity it can't deliver. */}
                {row.error ? (
                  <>
                    <button
                      type="button"
                      className={styles.resumeBtn}
                      disabled={resuming[row.id] === 'sending'}
                      onClick={() => doResume(row.id)}
                    >
                      {resuming[row.id] === 'sending'
                        ? 'Resuming…'
                        : meta.claude_session_id
                          ? 'Resume session?'
                          : 'Try again?'}
                    </button>
                    {resuming[row.id] && resuming[row.id] !== 'sending' ? (
                      <div className={styles.errorNote}>{resuming[row.id]}</div>
                    ) : null}
                  </>
                ) : null}
                {renderFiles(row)}

                {/* Fork-the-work: offload a bloated long-runner. Only offered
                    while it's actually working and has a surface to hand over.
                    Take-over, not parallel — she stops this one, then opens the
                    fork (no auto-navigate that would run both at once). */}
                {row.running && row.fileCount > 0 ? (
                  fork[row.id] === 'done' ? (
                    <div className={styles.forkDone}>
                      ✓ Forked into a fresh session. Stop this one first, so the two don&rsquo;t
                      clobber each other.
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.forkBtn}
                      disabled={fork[row.id] === 'forking'}
                      onClick={() => doFork(row.id)}
                    >
                      {fork[row.id] === 'forking'
                        ? 'Staging a fork…'
                        : fork[row.id] === 'error'
                          ? 'Fork failed — tap to retry'
                          : 'Fork this work into a fresh session'}
                    </button>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
