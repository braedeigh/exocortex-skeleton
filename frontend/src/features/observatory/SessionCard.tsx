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
 * Pointing the mouse at any of the three lights that session's orb on the
 * Terrain map, when the map is open in another tile
 * (shell/panels/agentHoverBus.ts).
 *
 * Shares SessionLane.module.css — the cards and the lane are one visual
 * language, and the stylesheet is named for it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { agentPointerProps } from '../../shell/panels/agentHoverBus';
import { dispatchIntent } from '../../shell/panels/windowBus';
import {
  forkConversation,
  keepConversation,
  saveForLater,
  sendToInbox,
  stopConversation,
  streamSend,
  type SessionMeta,
} from './api';
import { resumeAfterDecision } from './resumeAfterDecision';
import { CommandDecision } from './CommandDecision';
import type { OrchestraRow } from './orchestra';
import { cardMetaLine } from './sessionStatus';
import { cardState, sessionIs, type CardState } from './sessionFilters';
import { SessionMemoryChip } from '../runqueue/SessionMemoryChip';
import { ProposalBadge, ProposalsOnRow } from '../approvals/ProposalsOnRow';
import styles from './SessionLane.module.css';

/* The card's whole visual vocabulary, in two tables. cardState says WHICH state
   (from the same predicates the rail's buttons use); these say what it LOOKS
   like. Adding a state is a row in each table and a rule in the stylesheet —
   never another branch buried in the markup.

   'rest' has no card class on purpose: a cold card is the plain card. 'unread'
   has none either: an unread reply is a plain grey card whose DOT stays orange
   — only a session that needs her answer wears the orange card. (An asking
   session normally draws as AwaitingCard/ApprovalCard; the row is here so the
   table stays total.) */
const CARD_CLASS: Record<CardState, string> = {
  error: 'cardError',
  running: 'cardLive',
  asking: 'cardUnread',
  unread: '',
  recent: 'cardRecent',
  rest: '',
};

const DOT_CLASS: Record<CardState, string> = {
  error: 'errorDot',
  running: 'liveDot',
  asking: 'readyDot',
  unread: 'readyDot',
  recent: 'recentDot',
  rest: 'restDot',
};

/** Her last ask, clamped to three lines with a tap to open it up.
 *
 * The button only appears when the text ACTUALLY overflows, and the only way
 * to know that is to ask the browser: with -webkit-line-clamp there's no
 * character count that answers it, because the answer moves with the card's
 * width and her font size. So we render the clamped text, compare scrollHeight
 * against clientHeight, and re-measure whenever the box is resized — a phone
 * rotation or a lane that reflows changes the answer.
 *
 * Expanded state is deliberately ephemeral: it lives here and resets on
 * reload. Opening a message is a peek, not a preference — and the card is
 * keyed by conversation id in the lane, so it survives every roster poll.
 */
function LastPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Measured against the CLAMPED box, so it has to run while clamped — once
  // expanded, scrollHeight and clientHeight match and the question is moot.
  // That's why `expanded` isn't a dependency: the last honest measurement,
  // taken before she opened it, is the one that stays true.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!ref.current || expanded) return;
      setOverflows(ref.current.scrollHeight > ref.current.clientHeight + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  return (
    <>
      <div
        ref={ref}
        className={[styles.lastPrompt, expanded ? '' : styles.lastPromptClamped]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Curly quotes as real text, not ::before/::after — a pseudo-element
            on a clamped box gets cut off with the line it lands on, so the
            closing quote used to vanish on exactly the long messages this
            feature exists to show. */}
        {'“'}
        {text}
        {'”'}
      </div>
      {overflows ? (
        <button
          type="button"
          className={styles.lastPromptToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

// What a resumed session is told. `--resume` hands it the whole conversation
// back, so this is a CUE, not context — and a deliberately cautious one: the
// turn died mid-flight, possibly halfway through an edit, and a blunt
// "continue" invites it to redo work it already did. Look first, then decide.
const RESUME_CUE =
  'That turn ended in an error. Check what state things are actually in before continuing.';

/** Needs her OK — a gated command the act-ask gate stopped: the session's title
 * and a way into it, then the shared decision body (CommandDecision.tsx). The
 * same body also appears inside the chat that's asking (ChatApprovalCard.tsx). */
export function ApprovalCard({
  row,
  onOpen,
  onChanged,
}: {
  row: OrchestraRow;
  onOpen: (convId: string) => void;
  onChanged?: () => void;
}) {
  return (
    <div className={styles.approval} {...agentPointerProps(row.id)}>
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
      <CommandDecision
        convId={row.id}
        command={row.pendingApproval?.command ?? ''}
        onChanged={onChanged}
      />
    </div>
  );
}

/** Save for later, or Pick back up — one quiet full-width button at the foot
 * of a card. Saving parks the session in the roster's Saved for later section
 * (SavedLane.tsx): still open, questions and all, but the idle check never
 * wakes it and nothing on the page asks her about it. The roster poll moves
 * the card; this only says so while the request is out.
 * [prompt: "i'm also wanting to be able to save projects for later that the
 * system check doesn't send checks to ... keep that open but i don't want to
 * look at it right now"] */
export function SaveLaterButton({
  convId,
  saved,
  onChanged,
}: {
  convId: string;
  /** True in the Saved for later section: the button picks it back up. */
  saved: boolean;
  onChanged?: () => void;
}) {
  // 'busy' while the request is out, or the failure text.
  const [state, setState] = useState<'busy' | string | null>(null);
  const toggle = () => {
    setState('busy');
    saveForLater(convId, !saved)
      .then(() => {
        setState(null);
        onChanged?.();
      })
      .catch((err) => setState(err instanceof Error ? err.message : 'could not save it'));
  };
  return (
    <>
      <button
        type="button"
        className={saved ? styles.pickUpBtn : styles.laterBtn}
        disabled={state === 'busy'}
        onClick={toggle}
        title={
          saved
            ? 'Put it back in its room'
            : 'Keep it open but out of the way — no daily check, no nudges'
        }
      >
        {state === 'busy' ? '…' : saved ? 'Pick back up' : 'Save for later'}
      </button>
      {state && state !== 'busy' ? <div className={styles.errorNote}>{state}</div> : null}
    </>
  );
}

/** "Done — closes at 8:15 PM", its note, and the Keep open button. */
function DoneNote({
  meta,
  convId,
  onChanged,
}: {
  meta: SessionMeta;
  convId: string;
  onChanged?: () => void;
}) {
  const [keeping, setKeeping] = useState(false);
  const closesAt = new Date(meta.closes_at ?? '');
  const when = Number.isNaN(closesAt.getTime())
    ? 'soon'
    : closesAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className={styles.doneNote}>
      <div className={styles.doneText}>
        <strong>Done</strong> — closes itself at {when}
        {meta.done_note ? <div className={styles.doneWhat}>{meta.done_note}</div> : null}
      </div>
      <button
        type="button"
        className={styles.keepBtn}
        disabled={keeping}
        onClick={() => {
          setKeeping(true);
          keepConversation(convId)
            .then(() => onChanged?.())
            .catch(() => {
              /* a failed keep leaves the countdown showing — the poll re-syncs */
            })
            .finally(() => setKeeping(false));
        }}
      >
        Keep open
      </button>
    </div>
  );
}

/** Waiting on her — orange, every open question numbered, and a box right
 * under them that answers into the session without opening it. On a long list
 * the box stays at the bottom of the screen until she reaches the end of the
 * card, so she can type while the first question is still in view.
 *
 * The answer goes through the session's mailbox (sendToInbox), the same door
 * as typing into its chat while a turn runs: an idle session starts a turn
 * with it at once, a busy one gets it at its next step. Either way her words
 * are what clears the orange, server-side — so after a send the card just
 * says so and waits for the roster poll to take it away, rather than hiding
 * itself on a guess.
 *
 * [prompt: "on the front page, i want the orange sessions to have these
 * questions printed out with an input box beneath it that i can type directly
 * into to send into the session"] */
export function AwaitingCard({
  row,
  onOpen,
  onChanged,
}: {
  row: OrchestraRow;
  onOpen: (convId: string) => void;
  onChanged?: () => void;
}) {
  const [answer, setAnswer] = useState('');
  // 'sending' while it goes out, 'sent' once the mailbox has it, or the
  // failure text.
  const [sendState, setSendState] = useState<'sending' | 'sent' | string | null>(null);
  const questions = row.questions.length > 0 ? row.questions : [row.awaiting ?? ''];

  // Send her answer into the session, keeping the text if it fails.
  const send = () => {
    const text = answer.trim();
    if (!text || sendState === 'sending') return;
    setSendState('sending');
    sendToInbox(row.id, text, true)
      .then(() => {
        setAnswer('');
        setSendState('sent');
        onChanged?.();
      })
      .catch((err) => setSendState(err instanceof Error ? err.message : 'could not send'));
  };

  return (
    <div className={styles.awaiting} {...agentPointerProps(row.id)}>
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
      {/* The questions and the answer box share one wrapper, because the box
          is a sticky footer (SessionLane.module.css .answerForm): it holds at
          the bottom of the screen while the questions scroll, and the wrapper
          is what it can't leave. The title row sits outside it, so the box
          never rides up over the session's name. */}
      <div>
        {questions.length === 1 ? (
          <div className={styles.question}>{questions[0]}</div>
        ) : (
          <ol className={styles.questionList}>
            {questions.map((q, i) => (
              <li key={i} className={styles.question}>
                {q}
              </li>
            ))}
          </ol>
        )}
        <form
          className={styles.answerForm}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {/* Enter makes a new line, since an answer to several questions is
              often several lines; Ctrl/Cmd+Enter sends, like the chat. */}
          <textarea
            className={styles.answerInput}
            value={answer}
            rows={2}
            placeholder={questions.length > 1 ? 'Answer them here…' : 'Answer here…'}
            aria-label={`Answer ${row.title}`}
            disabled={sendState === 'sending'}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="submit"
            className={styles.answerSend}
            disabled={!answer.trim() || sendState === 'sending'}
          >
            {sendState === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>
      {sendState === 'sent' ? (
        <div className={styles.answerNote}>Sent — it has your answer.</div>
      ) : sendState && sendState !== 'sending' ? (
        <div className={styles.errorNote}>{sendState}</div>
      ) : null}
      {/* Not answering now: park it, questions and all, until she's back. */}
      <SaveLaterButton convId={row.id} saved={false} onChanged={onChanged} />
    </div>
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

  // Tap a file to read it. It goes to a code tile if one is open — including
  // one in another browser window, on another monitor (shell/panels/
  // windowBus.ts), and to the most recently touched one when several are. With
  // no code tile anywhere it falls back to what it always did: navigate, which
  // on desktop opens the file beside the lane and on mobile is a normal page
  // move that back returns from.
  const openFile = (repo: string, path: string) => {
    if (dispatchIntent({ kind: 'code', repo, path }) !== 'none') return;
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

  // What this card wears, decided by the SAME rule as the rail's coloured
  // buttons (sessionFilters.cardState) — so a purple dot on a card and the
  // purple button's count are one rule, written down once. The rail now
  // filters BY this paint, which is what makes "press orange, get orange".
  //
  // `unread` is the bare FACT, not the paint, and deliberately so: a running
  // session she hasn't read is still unread — it just wears purple, because
  // running outranks unread. The accent below says "there's something here you
  // haven't seen", which stays true under any colour.
  const state = cardState(meta, openedAt);
  const unread = sessionIs(meta, openedAt, 'unread');

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
      {...agentPointerProps(row.id)}
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
          {/* Handed its work on to a continuation — why it sits at the bottom. */}
          {meta.retired ? <span className={styles.badge}>handed on</span> : null}
          <ProposalBadge convId={row.id} />
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
      {/* Proposals this session's agent staged (a to-do, a note, a field
          change): who, what, where-from, and Open — decided in the room,
          never here. features/approvals/ProposalsOnRow. */}
      <ProposalsOnRow convId={row.id} onOpen={onOpen} />

      {/* What she asked, then what it made of it — cause above effect. Shown
          for the life of the session, not just while it works: she reads back
          through cold cards to find where she left something, and the summary
          alone doesn't say what she ASKED for.
          Everything about what's safe to show here was decided at send time
          (routes/observatory.py) — off-record and journaling sessions never
          store a last_prompt at all, so the card has nothing to withhold and
          never re-decides. That mattered when this was transient; it's the
          whole guarantee now that the line is permanent. */}
      {meta.last_prompt ? <LastPrompt text={meta.last_prompt} /> : null}
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
      {/* Done, and about to close itself. The session said its work is
          finished (scripts/session_done.py); the server closes it at the time
          shown unless she taps Keep open or anything starts a new turn in it.
          [prompt: "make sure that sessions that are completely done get auto
          closed"] */}
      {meta.done_at && !row.running ? (
        <DoneNote meta={meta} convId={row.id} onChanged={onChanged} />
      ) : null}
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
      {/* Park it: not while it's working (Stop is the control then), and never
          the Keeper, which is the door to her day. */}
      {!row.running && !meta.pinned ? (
        <SaveLaterButton convId={row.id} saved={Boolean(meta.saved_at)} onChanged={onChanged} />
      ) : null}

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
