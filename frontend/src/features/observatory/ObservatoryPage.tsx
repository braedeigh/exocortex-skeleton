import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { openActivity } from '../activity/openActivity';
import { uploadedPathsMessage } from '../phone/phoneLogic';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { TerrainBackdrop } from '../terrain/TerrainBackdrop';
import { ConversationApprovals } from '../approvals/ConversationApprovals';
import { ChatApprovalCard } from './ChatApprovalCard';
import { QuestionsCard } from './QuestionsCard';
import { CloseSourcePrompt, SpinoffOffer } from './SpinoffOffer';
import { setTerrainBackdropOn, useTerrainBackdropOn } from '../terrain/backdropPref';
import { createSession, getConversation, getSessions, isOutOfMemory, journalOutput, stopConversation, streamSend } from './api';
import { MemoryPrompt } from '../runqueue/MemoryPrompt';
import { enqueueConversation, fetchHeadroom } from '../runqueue/api';
import { shouldPrompt } from '../runqueue/memoryPrompt';
import type { Headroom } from '../runqueue/memoryPrompt';
import { applyEvent, assistantText, lastUserTurnIndex, turnsFromHistory, userTurn, type Turn } from './events';
import { HighlightPill, HighlightSheet } from './JournalHighlight';
import { useJournalHighlight } from './useJournalHighlight';
import { useComposerBox } from './useComposerBox';
import { formatSessionTokens, formatWorkingLine } from './turnStats';
import { isUnread, markConversationOpened } from './readReceipts';
import { useOpenSessionHeartbeat } from './useOpenSessions';
import { Reply, StreamingReply, UserMessage } from './replyViews';
import { useTurnStats } from './useTurnStats';
import { useWordFlow } from './useWordFlow';
import { useScrollContract } from './useScrollContract';
import { useStepBack, useStepBackDismiss } from './useStepBack';
import { PeerCard } from './PeerCard';
import { useMessageQueue } from './useMessageQueue';
import { usePhotoAttach, AttachChips, DropVeil, UploadOverlay } from './photoAttach';
import { useReattach } from './useReattach';
import { useKeeperRollover } from './useKeeperRollover';
import styles from './ObservatoryPage.module.css';

/** How many exchanges (her message plus what answered it) a session opens
 * showing, and how many more each "Show earlier" adds. Drawing a long
 * session's every reply at once was most of what made opening one slow. */
const EXCHANGES_SHOWN = 20;

/** Where the drawn window starts: the index of her `exchanges`-th message
 * counting back from the newest, or 0 when the whole history fits. */
function firstShownTurn(turns: Turn[], exchanges: number): number {
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user' && ++seen === exchanges) return i;
  }
  return 0;
}

/**
 * The observatory (bot-surface-design §5, Sunflower spec 07-23): not a
 * bubble chat. Her message is an epigraph — small, accent-ruled, hers; the
 * reply is body text.
 *
 * Scroll contract — FOLLOW-THEN-LOCK (her spec, 07-23): no jump on send. The
 * reply prints beneath her message and the page follows the new text like a
 * terminal — until her sent message reaches the top of the viewport, where
 * following stops dead and stays stopped; further text lands below the fold
 * for her to scroll into. A short reply never fills the screen, so the page
 * barely moves and never locks. Her own scroll (wheel/touch/keys) cancels
 * the following instantly — her hand always outranks the machine. The
 * ↓ latest pill is the only other way the page ever moves.
 *
 * Third clause — PARKED READING (her 07-23 ask, from the car): if she's been
 * sitting at the bottom for the dwell while a reply is still writing, the
 * page takes that as "I've read everything and I'm waiting" and starts
 * turning its own pages — each time a screenful of unread text pools past
 * her frontier, that frontier scrolls to the top and the new screen fills.
 * Paced page turns, not a crawl; any touch disarms it. See parkedReading.ts.
 *
 * WORD FLOW (her 07-23 ask): the wire's token bursts don't hit the page
 * raw — they pool in a backlog and release a word at a time, each word
 * fading in once (streamPacing.ts + StreamingReply below). Purely
 * presentational: turns still hold the full wire text; only the shown
 * frontier is paced. Stop dumps the backlog instantly.
 *
 * STEP BACK (her 07-30 ask, and the second half of a note she wrote on 07-27):
 * pull past the end of the conversation and it recedes to a strip at the top
 * of the page while the terrain backdrop takes everything below it, at full
 * strength and captioned with the agent's name, the directories it's working
 * inside, and the files it has touched. The map and the words both want the
 * whole screen; this lets them take turns instead of permanently compromising.
 * While it's up the scroll contract above is beside the point — she's watching,
 * not reading — so the page simply pins to the bottom and text prints into the
 * strip, and the word flow's releases ignite scattered rather than in reading
 * order, so the block fills in like a fire taking. See useStepBack.ts and
 * EMBER_SPREAD_MS.
 *
 * THE MAP IS OPTIONAL (▦ in the composer toolbar): one switch, remembered, for
 * every room and every window at once — turn it off here and the other windows
 * go quiet too, and it stays off until she presses it again. Off means the
 * backdrop unmounts, so nothing is drawing or polling behind the page, and the
 * step-back gesture stands down with it (there'd be nothing under it to see).
 * See features/terrain/backdropPref.ts.
 *
 * OPEN-AT-UNREAD ANCHOR (07-24): opening a conversation normally lands at
 * the bottom, like reopening a terminal — but if it's carrying activity she
 * hasn't seen since her last visit, that would drop her past the part she
 * hasn't read. Instead it lands with her LAST MESSAGE at the viewport top,
 * so the unread reply reads downward from there, same as a fresh reply she
 * just sent. See the history-load effect below and useScrollContract.ts's
 * pinToAnchor.
 *
 * DOCKED MODE (07-25): this page is also the desktop split's left pane (see
 * shell/KeeperPane.tsx), where there is no URL of its own to keep in step —
 * the address bar belongs to the right pane. `onOpenConversation` is that
 * seam: when it's passed, the two places this page would otherwise route
 * ("the session I just created", "the fresh Keeper the rollover woke") hand
 * the id to the pane instead, and the app's route never moves. Everything
 * else about the page is identical in both homes.
 */
export function ObservatoryPage({
  botId,
  convId,
  cameFrom,
  onOpenConversation,
  onTitleChange,
}: {
  botId: string;
  convId?: string;
  /** The chat a spinoff Go brought her here from (`?from=`), which this page
   * offers to close. See SpinoffOffer.tsx. */
  cameFrom?: string;
  onOpenConversation?: (convId: string) => void;
  /** Docked mode: report this session's title so the pane's tab can wear it
   * instead of a generic label. null while it's still unresolved. */
  onTitleChange?: (title: string | null) => void;
}) {
  const navigate = useNavigate();
  // Presence heartbeat: while this room is open and visible, stamp its
  // conversation "open" so the terrain page's agent bar can show it as active
  // (presence.ts). Keyed on convId, so the docked pane re-stamps when
  // it swaps conversations; a no-op until a convId exists (brand-new room).
  useOpenSessionHeartbeat(convId);
  // Sessions dissolved the "bot" persona (07-24) — there's no roster of named
  // bots to look a display name up in anymore. The header/placeholder show
  // the session's own title instead, filled in once the history load (below)
  // resolves it; a brand-new session (nothing to load yet) gets a plain
  // generic label.
  //
  // null means "not resolved yet", kept distinct from the generic label so the
  // docked pane's tab can hold off on wearing a title until there's a real one
  // (see onTitleChange) rather than flashing the placeholder as if it were one.
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  const roomLabel = roomTitle ?? 'Observatory';
  const [turns, setTurns] = useState<Turn[]>([]);
  // How many of her messages (each with its reply) the transcript draws,
  // counted from the newest. The whole history is still loaded and reduced —
  // only drawing is windowed — so every turn keeps its true index, which is
  // what journal highlights are addressed by. "Show earlier" widens it.
  const [shownExchanges, setShownExchanges] = useState(EXCHANGES_SHOWN);
  const firstShown = firstShownTurn(turns, shownExchanges);
  const [streaming, setStreaming] = useState(false);
  // False until the history load tells us whether a turn is still running
  // server-side — the spinoff auto-start waits on it (see canFire).
  const [histLoaded, setHistLoaded] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The "not enough room" prompt. `pending` is the message she was trying to
  // send, held here so Cancel gives it back and Queue can hand it over — a
  // refusal must never eat what she typed. `bypass` is set by "Start anyway"
  // so the retry doesn't ask the same question twice.
  const [memPrompt, setMemPrompt] = useState<{
    headroom: Headroom | null;
    serverRefused: boolean;
    pending: { text: string; offRecord: boolean };
  } | null>(null);
  const bypassHeadroomRef = useRef(false);
  // The terminal's floating sidekicks, ported: 📝 dev notes and the ⏰
  // prompt timer (the same shared panels the terminal pane uses).
  const [panel, setPanel] = useState<'notes' | 'schedule' | null>(null);
  const [schedSessions, setSchedSessions] = useState<string[]>([]);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  // Closed, and reached from the archive. The composer says so BEFORE she
  // types: sending into an archived session is what reopens it (the server
  // pops the flag on send — deliberate, it's the whole un-archive gesture),
  // and now that the archive is one tap from every transcript she'll be
  // landing in old sessions to READ far more often than to revive one.
  // Cleared on send, so the note never outlives the thing it warned about.
  const [sessionArchived, setSessionArchived] = useState(false);
  // Explicit journal state of this session (null until meta loads). Nothing
  // announces it in the composer — she knows which sessions are journaled; it
  // only gates the off-the-record toggle, which exists in journaled sessions.
  const [sessionJournal, setSessionJournal] = useState<boolean | null>(null);
  // Explicit pinned state of this session (null until meta loads) — the
  // "Roll over" control only exists in the one pinned session (the Keeper).
  const [sessionPinned, setSessionPinned] = useState<boolean | null>(null);
  // Lifetime output of this session, preformatted ("18.2k tokens"), or null
  // until a turn has finished. Refreshed whenever history reloads. Count only
  // in here — the cost stays on the roster card (turnStats.ts).
  const [sessionSpend, setSessionSpend] = useState<string | null>(null);
  // The roster's cached Haiku one-liner of what this session is working on
  // (SessionMeta.summary). Seeded on open like its neighbours here, then
  // refreshed whenever she pulls back to look — see the step-back effect below.
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  // Tap-to-journal: which assistant turn is armed (tap → "✦ put this in the
  // journal" appears → tap that to mint the K card).
  const [journalArmed, setJournalArmed] = useState<number | null>(null);
  // The stop button aborts this fetch AND calls the stop endpoint — the
  // server no longer kills claude just because the stream reader went away
  // (that's the whole PWA-close fix; only /stop kills a turn).
  const abortRef = useRef<AbortController | null>(null);
  // TRUE only when she pressed stop. The unmount cleanup aborts the same
  // controller (leaving for the terminal page, closing the app) — that
  // abort must NOT stop the server-side turn; it keeps writing without us.
  const stopIntentRef = useRef(false);
  // Re-entry guard for sendMessage (belt to the auto-send effect's braces).
  const busyRef = useRef(false);
  // Lets the re-attach poll loop stop cold on unmount.
  const mountedRef = useRef(true);
  // Draft prefill fires at most once per mount — the route remounts this
  // page on every conv change (see observatory_.$botId.tsx's `key`), so a
  // plain boolean here already can't leak a prefill across conversations;
  // it just also guards against a second history load inside the same
  // mount re-stomping something she's since edited or cleared.
  const draftAppliedRef = useRef(false);
  // A spun-off session auto-fires its staged kickoff (server sets
  // meta.autostart): the history load stashes the kickoff text here instead of
  // prefilling the compose box, and the effect further down fires it once
  // canFire goes true. The ref belt keeps that fire to exactly one.
  const [pendingAutostart, setPendingAutostart] = useState<string | null>(null);
  const autoStartFiredRef = useRef(false);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // The compose textarea's ref + the helpers that write into it (autosize,
  // draft prefill, failed-send restore) — see useComposerBox.ts.
  const composerBox = useComposerBox();
  const inputRef = composerBox.inputRef;
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // The conversation this page is writing into (set by the first send's
  // 'conv' frame for fresh conversations).
  const convRef = useRef<string | undefined>(convId);

  // Highlight-to-journal, the finer grain of the tap-to-journal gesture: the
  // selection listener, the ✦ pill's target, and the sheet lifecycle all live
  // in useJournalHighlight.ts — this page just renders pill + sheet from it.
  const highlight = useJournalHighlight({ convRef, turnsRef, onTurns: setTurns });

  const turnStats = useTurnStats(streaming);

  const reattachApi = useReattach({
    convRef,
    mountedRef,
    onTurns: setTurns,
    // the token/thought counts died with the old stream
    onStart: turnStats.reset,
    onGiveUp: setSendError,
  });

  const writing = streaming || reattachApi.reattaching;
  const writingRef = useRef(writing);
  writingRef.current = writing;

  // Set from stepBack.active further down — the step-back view needs the
  // scroll contract, which needs the word flow, so the flag can only travel
  // this direction as a ref.
  const emberRef = useRef(false);
  const wordFlow = useWordFlow(turnsRef, writingRef, emberRef);
  const scrollContract = useScrollContract({
    turns,
    shownChars: wordFlow.shownChars,
    streaming,
    writing,
  });

  // Step back to watch the terrain (useStepBack.ts): pull past the end of the
  // conversation and it recedes to a strip while the map takes the screen,
  // clean and captioned. It borrows the contract's bottom-pin rather than
  // carrying scroll logic of its own — the strip wants exactly what a terminal
  // wants, the newest line held at the bottom while text prints into it.
  const pageRef = useRef<HTMLDivElement>(null);
  // The ▦ toolbar button below turns the map off for every room and every
  // window at once (backdropPref.ts). With no map behind the page, stepping
  // back would uncover a blank screen — so the gesture goes away with it.
  const backdropOn = useTerrainBackdropOn();
  const stepBack = useStepBack({
    scrollRef: scrollContract.scrollRef,
    pageRef,
    pinToBottom: scrollContract.pinToBottom,
    enabled: backdropOn,
  });
  const stepBackDismiss = useStepBackDismiss(stepBack.exit);
  // Closes the loop opened at emberRef's declaration: the word flow's cool-down
  // window widens to cover the scatter for as long as the view is up.
  emberRef.current = stepBack.active;

  // The summary refreshes on the gesture rather than on a timer: it's the one
  // moment she's actually looking at it, and the server only regenerates the
  // line about once a minute anyway, so a poll would mostly re-fetch the same
  // sentence. /api/observatory carries every session's meta WITHOUT its events,
  // so this costs a roster read rather than a transcript.
  useEffect(() => {
    if (!stepBack.active || !convId) return;
    const ac = new AbortController();
    getSessions(ac.signal)
      .then((data) => {
        const mine = (data.sessions ?? []).find((s) => s.id === convId);
        if (mine) setSessionSummary(mine.summary ?? null);
      })
      // A stale sentence beats an error here — the view is still doing its job
      // without it, and there's nothing she could act on.
      .catch(() => {});
    return () => ac.abort();
  }, [stepBack.active, convId]);

  // History load when opening an existing conversation — landing at the
  // latest turn, like reopening a terminal session.
  useEffect(() => {
    const prevConv = convRef.current;
    convRef.current = convId;
    if (!convId) {
      setTurns([]);
      setHistLoaded(true); // nothing running in a conversation that isn't
      return;
    }
    // The URL catching up to a conversation this page is already
    // mid-stream in (a blank compose's first turn just named itself, and a
    // queued message may already be running the next turn): live state is
    // fresher than the log — refetching would clobber the open turn.
    if (busyRef.current && prevConv === convId) {
      setHistLoaded(true);
      return;
    }
    setHistLoaded(false);
    let cancelled = false;
    getConversation(convId)
      .then((data) => {
        if (cancelled) return;
        const loadedTurns = turnsFromHistory(data.events);
        setTurns(loadedTurns);
        setSessionJournal(data.meta?.journal === true ? true : data.meta?.journal === false ? false : null);
        setSessionPinned(data.meta?.pinned === true);
        setSessionArchived(Boolean(data.meta?.archived));
        setSessionSpend(data.meta?.tokens ? formatSessionTokens(data.meta.tokens) : null);
        setSessionSummary(data.meta?.summary ?? null);
        if (data.meta?.title) setRoomTitle(data.meta.title);
        // Draft prefill: a staged first message she hasn't fired yet. Only
        // takes the compose box if it's still empty (never stomp something
        // she's already typed) and only once per mount (the server clears
        // the draft after a real send; re-loading history within the same
        // mount — the busyRef fast path above skips this call entirely, but
        // belt-and-suspenders — must not re-inject it).
        if (!draftAppliedRef.current && typeof data.meta?.draft === 'string' && data.meta.draft.trim()) {
          draftAppliedRef.current = true;
          if (data.meta?.autostart) {
            // A /spinoff session: don't put the kickoff in the box for her to
            // send — stash it for the autostart effect below, which fires it
            // the moment the load settles. The server clears draft+autostart on
            // that send, so it never re-fires.
            setPendingAutostart(data.meta.draft);
          } else {
            composerBox.fillIfEmpty(data.meta.draft);
          }
        }
        // Capture the stamp BEFORE it's overwritten — this open's own
        // freshness can't be judged against a mark this same open just made.
        const prevOpened = markConversationOpened(convId);
        // Reopened onto a turn that's still writing (the PWA was closed
        // mid-reply and the turn kept going) — pick it back up.
        if (data.meta?.running === true) void reattachApi.reattach(convId);
        setHistLoaded(true);
        // Open-at-unread anchor: if she left new activity unread since her
        // last visit, land with her last message at the viewport top so the
        // unread reply reads downward from there — otherwise land at the
        // latest turn, always, like reopening a terminal (the pin keeps us
        // there while the rendered markdown finishes laying out — see
        // useScrollContract.ts).
        const anchorIdx = lastUserTurnIndex(loadedTurns);
        if (isUnread(data.meta?.last_at, prevOpened)) {
          if (anchorIdx >= 0) scrollContract.pinToAnchor(anchorIdx);
          // Unread but she's never sent a message (a fresh session someone
          // else fed events into) — nothing to anchor on; the container
          // naturally starts at the top, which is the right place to start
          // catching up anyway.
        } else {
          scrollContract.pinToBottom();
        }
      })
      .catch(() => {
        // histLoaded stays false — with the conversation's state unknown,
        // a restored queue holds its fire.
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
    // reattachApi.reattach / scrollContract.pinToBottom / scrollContract.pinToAnchor
    // are stable (useCallback, [] deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, reattachApi.reattach, scrollContract.pinToBottom, scrollContract.pinToAnchor]);

  // Docked mode: hand the title to the pane holding us, so its tab reads as the
  // session she's actually in. Fires with null on mount too — the pane remounts
  // this page per conversation, so that's what clears the previous session's
  // name off the tab while the new one loads.
  useEffect(() => {
    onTitleChange?.(roomTitle);
  }, [roomTitle, onTitleChange]);

  // The pause (off-record) button only exists where the journal is live —
  // in a workshop session there's nothing to pause. Clear any stale state
  // when the session turns out not to journal.
  useEffect(() => {
    if (sessionJournal !== true) setOffRecord(false);
  }, [sessionJournal]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const sendMessage = useCallback(
    async (text: string, sendOffRecord: boolean) => {
      if (busyRef.current) return;

      // Ask BEFORE anything moves. The box holds about three sessions at once,
      // and the server only hard-refuses at its own floor — so without this the
      // fourth session either starts and squeezes the site, or dies on a 503
      // after her message has already been drawn into the transcript. Checked
      // first, while cancelling still costs nothing. A headroom call that fails
      // returns null and sends exactly as before.
      if (!bypassHeadroomRef.current) {
        const headroom = await fetchHeadroom();
        if (shouldPrompt(headroom)) {
          setMemPrompt({ headroom, serverRefused: false, pending: { text, offRecord: sendOffRecord } });
          return;
        }
      }
      bypassHeadroomRef.current = false;

      busyRef.current = true;
      setSendError(null);

      // This send IS the un-archive (server-side), so the note goes with it.
      setSessionArchived(false);
      const next = [...turnsRef.current, userTurn(text, sendOffRecord)];
      setTurns(next);
      setStreaming(true);
      // The word flow starts fresh: the reply will land at next.length and
      // release from character zero.
      wordFlow.begin(next.length);
      turnStats.start(Date.now());

      // No jump — start following: the reply prints below her message and
      // the page tracks it until that message reaches the top (the lock),
      // or she scrolls (the cancel). The open-at-bottom pin hands off to
      // the follow here (see useScrollContract.ts).
      scrollContract.beginFollow(next.length - 1);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      stopIntentRef.current = false;
      try {
        let conv = convRef.current;
        if (!conv) {
          // The old create-implicitly-on-send flow is gone from this
          // client (sessions carry their own config server-side now, so a
          // send needs a real id to send into) — a brand-new blank compose
          // creates its session explicitly first, titled from what she's
          // about to say, same journal-off default as the roster's own
          // '+ New session' dialog.
          const created = await createSession(text.slice(0, 40), false);
          conv = created.id;
          convRef.current = conv;
          // The URL catches up as soon as the session exists, not once the
          // reply finishes — a reload mid-turn lands back here instead of a
          // blank compose that would try to create a second session. Docked
          // in the split pane there's no URL to catch up; the pane takes the
          // id instead (same effect: a reload resolves back to this session).
          if (onOpenConversation) onOpenConversation(conv);
          else
            void navigate({
              to: '/observatory/$botId',
              params: { botId },
              search: { conv },
              replace: true,
            });
        }
        await streamSend(
          conv,
          text,
          { record: !sendOffRecord, signal: ctrl.signal },
          (event) => {
            applyEvent(turnsRef.current, event);
            setTurns([...turnsRef.current]);
            turnStats.apply(event, Date.now());
          },
        );
        markConversationOpened(conv);
      } catch (e) {
        if (ctrl.signal.aborted) {
          if (stopIntentRef.current) {
            // Her stop, not a failure: what streamed stays — close the
            // writing turn cleanly, and actually stop the server-side run
            // (a dead stream alone no longer stops anything).
            if (convRef.current) void stopConversation(convRef.current).catch(() => {});
            const last = turnsRef.current[turnsRef.current.length - 1];
            if (last && last.role === 'assistant') {
              last.open = false;
              last.tool = null;
            }
            setTurns([...turnsRef.current]);
          }
          // Otherwise: the page went away (another route, closed app). The
          // turn keeps writing server-side; whoever opens this conversation
          // next re-attaches to it. Nothing to do here.
        } else if (isOutOfMemory(e)) {
          // Refused for want of memory — nothing is broken and nothing is
          // running, so this must NOT fall through to reattach (there'd be no
          // turn to find). Take her message back out of the transcript and
          // offer the same choice the proactive check offers, minus "start
          // anyway": the server has already said no to that.
          setTurns(turnsRef.current.filter((t, i) => !(i === next.length - 1 && t.role === 'user')));
          setMemPrompt({
            headroom: ((e as { headroom?: Headroom }).headroom ?? null) as Headroom | null,
            serverRefused: true,
            pending: { text, offRecord: sendOffRecord },
          });
        } else if (convRef.current) {
          // The turn is known server-side and keeps writing without us
          // (closed PWA, dropped proxy) — don't unsay her message; go find
          // the reply in the record instead.
          await reattachApi.reattach(convRef.current);
        } else {
          // Never reached the server: restore so nothing is eaten (photo
          // refs are text lines now, so they come back with the message).
          composerBox.restore(text);
          setSendError(e instanceof Error ? e.message : 'Send failed — message restored.');
          setTurns(turnsRef.current.filter((t, i) => !(i === next.length - 1 && t.role === 'user')));
        }
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        setStreaming(false);
      }
    },
    // The functions below are stable (useCallback, [] deps in their own hooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      botId,
      navigate,
      onOpenConversation,
      reattachApi.reattach,
      wordFlow.begin,
      turnStats.start,
      turnStats.apply,
      scrollContract.beginFollow,
    ],
  );

  const rollover = useKeeperRollover({ botId, pinned: sessionPinned === true, onOpenConversation });

  const photo = usePhotoAttach();

  // canFire: nothing running server-side, no turn actively streaming/
  // pacing/reattaching, and no unresolved send error — the gate for the
  // spinoff auto-start below. (Her queued messages don't wait on it any more:
  // the server's mailbox delivers them — see useMessageQueue.ts.)
  const canFire = histLoaded && !writing && !wordFlow.pacing && !sendError;
  const messageQueue = useMessageQueue({ botId, convId });

  // Auto-start a spun-off session: once history has loaded and nothing else is
  // running (canFire), fire the staged kickoff exactly once through the normal
  // send path — so the turn spawns server-managed and durable, and the server
  // clears draft+autostart on that send so a reopen can't re-fire it.
  useEffect(() => {
    if (pendingAutostart == null || !canFire || autoStartFiredRef.current) return;
    autoStartFiredRef.current = true;
    const kickoff = pendingAutostart;
    setPendingAutostart(null);
    void sendMessage(kickoff, false);
  }, [pendingAutostart, canFire, sendMessage]);

  const send = () => {
    const typed = inputRef.current?.value.trim() ?? '';
    // Photos may go alone (refs are a message), but empty-empty is nothing.
    if (!typed && photo.attached.length === 0) return;
    composerBox.take();
    const paths = photo.drain();
    const text = paths.length
      ? uploadedPathsMessage(paths) + (typed ? `\n${typed}` : '')
      : typed;
    if (writing) {
      // A turn is still going — send it to the session's mailbox, which
      // hands it to the agent at its next step (useMessageQueue.ts). Each
      // message keeps the record state it was written under.
      messageQueue.enqueue(text, offRecord);
      return;
    }
    void sendMessage(text, offRecord);
  };

  // Enter sends, Shift+Enter (or Ctrl/Cmd+Enter) makes a newline — but only
  // where there's a real keyboard. On a phone the on-screen return key must
  // stay a return key, so the gate is the pointer, not the window width: a
  // narrow desktop window still sends, a wide tablet still gets its newline.
  // IME composition (`isComposing`) swallows the Enter that commits a
  // candidate word, so that keystroke never sends a half-typed message.
  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.nativeEvent.isComposing) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    e.preventDefault();
    send();
  };

  const stopTurn = () => {
    // Her stop dumps the word flow's backlog — whatever streamed shows whole.
    wordFlow.flush();
    if (abortRef.current) {
      stopIntentRef.current = true; // this abort MEANS stop (unmount's doesn't)
      abortRef.current.abort();
    } else if (writingRef.current && convRef.current) {
      // Re-attach mode: no fetch to abort — stop the server-side turn
      // directly; the poll sees `running` clear and settles. (Not writing at
      // all → the turn already ended and only the printing lagged; flushing
      // the flow above was the whole job.)
      void stopConversation(convRef.current).catch(() => {});
    }
  };

  // Escape stops the turn from anywhere on the page — the Claude Code gesture,
  // no reaching for the stop button, and it works with the cursor sitting in
  // the composer. An open notes/timer panel gets the key first (Escape closes
  // it), so the key can't kill a turn out from under her while she's somewhere
  // else; with nothing running it does nothing at all. The handler is kept in
  // a ref that's refreshed every render, so the window listener binds once and
  // still always sees current state.
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => {
    if (panel) {
      setPanel(null);
      return;
    }
    if (!writingRef.current && !wordFlow.pacing) return;
    stopTurn();
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A composing IME owns Escape (it cancels the candidate) — leave it be.
      if (e.key !== 'Escape' || e.isComposing) return;
      escapeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const togglePanel = (name: 'notes' | 'schedule') => {
    if (name === 'schedule' && schedSessions.length === 0) {
      // The timer schedules prompts into tmux sessions (the dispatcher's
      // delivery lane) — fetch their names once, on first open.
      fetch('/api/sessions')
        .then((r) => r.json())
        .then((d) => setSchedSessions(Array.isArray(d.sessions) ? d.sessions : []))
        .catch(() => {});
    }
    setPanel((p) => (p === name ? null : name));
  };

  // Stable callbacks (refs only) so the memoized Reply rows below actually
  // skip re-rendering — closed turns re-running mdToHtml on every token
  // delta was the transcript's main render cost.
  const tapReply = useCallback((i: number) => {
    const t = turnsRef.current[i];
    if (!t || t.open || t.journaled || !convRef.current) return;
    // Finishing a text selection also fires this click. Two journal offers at
    // once — the whole-reply button and the ✦ pill — is a muddle, and the
    // narrower one is obviously what she meant, so the selection wins.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    setJournalArmed((a) => (a === i ? null : i));
  }, []);

  const journalReply = useCallback(async (i: number) => {
    const conv = convRef.current;
    const t = turnsRef.current[i];
    if (!conv || !t || t.journaled) return;
    try {
      await journalOutput(conv, assistantText(t));
      t.journaled = true;
      setTurns([...turnsRef.current]);
    } catch {
      setSendError('Could not put that reply in the journal.');
    } finally {
      setJournalArmed(null);
    }
  }, []);

  return (
    <div
      ref={pageRef}
      className={[styles.page, stepBack.active ? styles.pageStepBack : ''].filter(Boolean).join(' ')}
    >
      {/* The terrain map behind the conversation, and the step-back view that
          hands it the screen. The glass and the featured agent are separate
          steps and land separately — see TerrainBackdrop.tsx. Unmounted rather
          than hidden when she's turned it off, so the canvas, the breath and
          the terrain polling all stop with it. */}
      {backdropOn ? <TerrainBackdrop focusConv={convId} revealed={stepBack.active} /> : null}

      <div ref={scrollContract.scrollRef} className={styles.scroll}>
        <div ref={scrollContract.columnRef} className={styles.column}>
          {convId && cameFrom && cameFrom !== convId ? <CloseSourcePrompt convId={convId} from={cameFrom} /> : null}
          {firstShown > 0 ? (
            <button
              type="button"
              className={styles.showEarlier}
              onClick={() => setShownExchanges((n) => n + EXCHANGES_SHOWN)}
            >
              Show earlier messages
            </button>
          ) : null}
          {turns.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyName}>{roomLabel}</div>
              <div className={styles.emptyHint}>Whenever you&rsquo;re ready.</div>
            </div>
          ) : (
            turns.slice(firstShown).map((t, shownIndex) => {
              // Keys and indices stay absolute (the turn's place in the whole
              // history), never its place in the window.
              const i = firstShown + shownIndex;
              if (t.role === 'user') {
                return (
                  <UserMessage
                    key={i}
                    index={i}
                    text={t.text}
                    offRecord={t.offRecord}
                    highlights={t.highlights}
                  />
                );
              }
              if (t.role === 'gap') {
                return (
                  <div key={i} className={styles.gap}>
                    — off the record —
                  </div>
                );
              }
              if (t.role === 'decision') {
                // A gated command she approved/denied — the actual command,
                // labelled, so the transcript says what she did (green ✓ /
                // red ✕) instead of a blank "off the record" hole.
                const approved = t.decision !== 'deny';
                return (
                  <div
                    key={i}
                    className={[styles.decision, approved ? styles.decisionApprove : styles.decisionDeny].join(' ')}
                  >
                    <span className={styles.decisionLabel}>{approved ? '✓ Approved' : '✕ Denied'}</span>
                    <code className={styles.decisionCmd} title={t.text}>
                      {t.text}
                    </code>
                  </div>
                );
              }
              if (t.role === 'reminder') {
                // A System message the app sent — a Coming up reminder at its
                // set time, or a background job reporting back — labelled with
                // where it came from, so it never reads as her words.
                return (
                  <div key={i} className={styles.reminder}>
                    <span className={styles.reminderLabel}>
                      {t.source === 'job'
                        ? '⚙ Background job finished'
                        : `⏰ System reminder · set by ${t.source === 'keeper' ? 'the keeper' : 'you'}`}
                    </span>
                    <span className={styles.reminderText}>{t.text}</span>
                  </div>
                );
              }
              if (t.role === 'peer' && t.peer) {
                return <PeerCard key={i} peer={t.peer} text={t.text} />;
              }
              if (t.role === 'error') {
                return (
                  <div key={i} className={styles.error}>
                    {t.text}
                  </div>
                );
              }
              if (wordFlow.pacing && i === wordFlow.paceIdx) {
                return (
                  <StreamingReply
                    key={i}
                    t={t}
                    shown={wordFlow.shownChars}
                    cooled={wordFlow.cooledChars}
                    frost={wordFlow.frostChars}
                    ember={stepBack.active}
                  />
                );
              }
              return (
                <Reply
                  key={i}
                  index={i}
                  text={t.text}
                  buffer={t.buffer}
                  open={t.open}
                  tool={t.tool}
                  journaled={t.journaled}
                  highlights={t.highlights}
                  armed={journalArmed === i}
                  onBodyTap={tapReply}
                  onJournalTap={journalReply}
                />
              );
            })
          )}
          {writing ? (
            <div className={styles.writing}>
              <span className={styles.writingDot} />{' '}
              {turnStats.stats ? formatWorkingLine(turnStats.stats, Date.now()) : 'still writing…'}
              {scrollContract.parkArmed ? ' · turning pages for you' : ''}
            </div>
          ) : null}
          {/* Proposals THIS conversation's agent staged (a to-do, a note, a
              field change) land here as cards in the transcript, after its
              latest words — Approve / edit / Deny in place. Not the
              window-wide sheet: features/approvals/ConversationApprovals. */}
          {convId ? <ConversationApprovals convId={convId} /> : null}
          {/* ...and a command the gate stopped, Approve / Deny in place — the
              same card the room view shows. */}
          {convId ? <ChatApprovalCard convId={convId} /> : null}
          {/* A /spinoff this agent staged shows up as a Go card here, under its
              latest words: features/observatory/SpinoffOffer. */}
          {convId ? <SpinoffOffer convId={convId} writing={writing} pinned={sessionPinned === true} /> : null}
          {/* The questions this session filed for her, floating at the bottom
              of the chat until she answers: features/observatory/QuestionsCard. */}
          {convId ? <QuestionsCard convId={convId} /> : null}
          {messageQueue.queued.map((q, i) => (
            <div key={i} className={styles.queuedRow}>
              <span className={styles.queuedTag}>queued</span>
              <span className={styles.queuedText}>{q.text}</span>
              <button
                type="button"
                className={styles.queuedX}
                aria-label="Remove queued message"
                onClick={() => messageQueue.removeAt(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* The room the conversation gives up when she pulls past its end (see
          useStepBack.ts + .stepBackRoom). Below the conversation, so the strip
          it leaves behind sits at the TOP of the page and the map fills
          everything under it. Always mounted at zero height, so the transition
          interpolates instead of popping; it's also the surface that hands the
          screen back. */}
      <div className={styles.stepBackRoom} {...stepBackDismiss}>
        {sessionSummary ? (
          <div className={styles.stepBackSummary}>{sessionSummary}</div>
        ) : null}
        <div className={styles.stepBackHint}>tap to return</div>
      </div>

      {/* Roll over — the pinned Keeper's one-tap "close the day, wake a fresh
          Keeper". Floats at the top-right of the page (her 07-24 ask) rather
          than living in the composer: it's a once-a-day, session-level act,
          not a message control, and the row it occupied down there was a row
          of height taken from the conversation. Confirm opens as a card under
          the button, so the destructive step stays anchored to what raised
          it. Still label-first, never a bare icon — it closes out a day. */}
      {sessionPinned === true ? (
        <div className={styles.rolloverFloat}>
          {rollover.phase === 'confirming' ? (
            <div className={styles.rolloverConfirmRow}>
              <span className={styles.rolloverConfirmText}>Close the day and wake a fresh Keeper?</span>
              <button
                type="button"
                className={styles.rolloverConfirmBtn}
                onClick={() => void rollover.confirm()}
              >
                Confirm
              </button>
              <button type="button" className={styles.rolloverCancelBtn} onClick={rollover.cancelConfirm}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.rolloverBtn}
              disabled={rollover.phase === 'rolling'}
              aria-busy={rollover.phase === 'rolling'}
              onClick={rollover.requestConfirm}
            >
              {rollover.phase === 'rolling' ? (
                <span className={styles.rolloverSpin} aria-hidden="true" />
              ) : (
                '\u{1F319}'
              )}
              {rollover.phase === 'rolling' ? 'Rolling over\u2026' : 'Roll over'}
            </button>
          )}
          {rollover.phase === 'error' && rollover.errorMsg ? (
            <span className={styles.rolloverError}>{rollover.errorMsg}</span>
          ) : null}
        </div>
      ) : null}

      {/* Notes + timer panels — their trigger buttons live in the composer
          toolbar now (the corner cluster folded into it, her 07-23 ask). */}
      <TermNotesPanel open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />
      <SchedulePanel
        open={panel === 'schedule'}
        onClose={() => setPanel(null)}
        triggerRef={schedBtnRef}
        sessionNames={schedSessions}
      />

      {/* showJump alone covers a live reply scrolled out of view; catchingUp
          covers the open-at-unread anchor's idle side — a conversation
          that isn't writing at all still has an unread reply waiting below
          her anchored message, so the pill stays offered until she either
          scrolls near it herself or taps this. */}
      {scrollContract.showJump || scrollContract.catchingUp ? (
        <button type="button" className={styles.jumpPill} onClick={scrollContract.jumpToLatest}>
          ↓ latest
        </button>
      ) : null}

      <div className={[styles.composer, offRecord ? styles.composerOff : ''].filter(Boolean).join(' ')}>
        {sendError ? <div className={styles.sendError}>{sendError}</div> : null}
        {/* Same rule as the off-the-record note below: say exactly what the
            machinery does. Reading a closed session is free; sending reopens
            it and starts spending — she should know that before she types,
            not after. */}
        {sessionArchived ? (
          <div className={styles.archivedNote}>
            this session is closed — sending will reopen it
          </div>
        ) : null}
        {/* The note has to match the machinery exactly (Terra, 07-23). It used
            to say "not kept", and that was the whole complaint: the turn really
            did vanish from her own chat. Now off the record stops at the
            journal, and the note says so. */}
        {offRecord ? (
          <div className={styles.offNote}>
            off the record — stays in this chat, never goes in the journal
          </div>
        ) : null}
        <AttachChips attached={photo.attached} onRemove={photo.remove} />
        {/* The old bottom bar's toolbar row, same colors and placement —
            directly above the input, twilight-indigo like the terminal
            chrome. Notes/timer/jumps moved in from the corner cluster; the
            journal pause (●/◌) appears only where the journal is live. */}
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolBtn} onClick={photo.openPicker}>
            photo
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to top"
            aria-label="Jump to top"
            onClick={() => scrollContract.jumpTo('top')}
          >
            &#9650;&#9650;
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to bottom"
            aria-label="Jump to bottom"
            onClick={() => scrollContract.jumpTo('bottom')}
          >
            &#9660;&#9660;
          </button>
          {sessionJournal === true ? (
            <button
              type="button"
              className={[styles.toolBtn, offRecord ? styles.toolBtnPaused : ''].filter(Boolean).join(' ')}
              title={offRecord ? 'Back on the record' : 'Go off the record'}
              aria-label={offRecord ? 'Back on the record' : 'Go off the record'}
              aria-pressed={offRecord}
              onClick={() => setOffRecord((v) => !v)}
            >
              {offRecord ? '◌' : '●'}
            </button>
          ) : null}
          {/* The map behind the page, on or off. One switch for every room and
              every window (backdropPref.ts), so turning it off here quiets the
              other windows too rather than only this one. */}
          <button
            type="button"
            className={[styles.toolBtn, backdropOn ? '' : styles.toolBtnPaused].filter(Boolean).join(' ')}
            title={backdropOn ? 'Hide the terrain map' : 'Show the terrain map'}
            aria-label={backdropOn ? 'Hide the terrain map' : 'Show the terrain map'}
            aria-pressed={!backdropOn}
            onClick={() => setTerrainBackdropOn(!backdropOn)}
          >
            {/* Filled/hollow, the same on-off idiom the journal pause uses
                above — and geometric rather than an emoji map, so the muted
                colour of the off state actually lands on the glyph. */}
            {backdropOn ? '▦' : '▢'}
          </button>
          {/* This session's steps, live — every tool call with its output
              (features/activity/). Beside the session on a wide screen,
              its own page on a phone. */}
          <button
            type="button"
            className={styles.toolBtn}
            disabled={!convId}
            title="Watch this session's activity"
            aria-label="Watch this session's activity"
            onClick={() => {
              const conv = convRef.current ?? convId;
              if (!conv) return;
              openActivity(conv, () => void navigate({ to: '/terrain/activity', search: { agent: conv } }));
            }}
          >
            activity
          </button>
          <button
            ref={notesBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Dev notes"
            aria-label="Dev notes"
            onClick={() => togglePanel('notes')}
          >
            &#128221;
          </button>
          <button
            ref={schedBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Schedule a prompt"
            aria-label="Schedule a prompt"
            onClick={() => togglePanel('schedule')}
          >
            &#9200;
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            // Live through the post-turn drain too: while the word flow is
            // still printing, stop skips to the end of the reply.
            disabled={!writing && !wordFlow.pacing}
            title="Stop the reply"
            aria-label="Stop the reply"
            onClick={stopTurn}
          >
            stop
          </button>
          <input
            ref={photo.fileRef}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            className={styles.fileInput}
            onChange={(e) => void photo.onPhotoChange(e.currentTarget)}
          />
        </div>
        <div className={styles.composerRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={`message ${roomLabel}…`}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            onKeyDown={onComposerKeyDown}
            onInput={composerBox.autosize}
          />
          {/* Never disabled while writing — a send mid-turn queues (the
              queued rows above the composer). */}
          <button type="button" className={styles.sendBtn} aria-label="Send" onClick={send}>
            ↑
          </button>
        </div>
        {/* How much this session has written, sitting directly under the input
            — her call, so on the phone it's the line right above the keyboard
            rather than buried in the toolbar above the box. The count only, no
            dollars ("I prefer the number only"): the roster card is where the
            cost lives. It advances a turn at a time, since the total only
            lands when a turn finishes. */}
        {sessionSpend ? (
          <div className={styles.spend} title="Tokens written this session">
            {sessionSpend}
          </div>
        ) : null}
      </div>

      <DropVeil active={photo.dragging} />
      <UploadOverlay upload={photo.upload} />

      {/* The ✦ pill rides the selection; the sheet takes over from it. Both sit
          outside the scroll container so the pill's fixed position isn't
          measured against a scrolled parent. */}
      {highlight.pending && !highlight.sheetOpen ? (
        <HighlightPill
          left={highlight.pending.left}
          top={highlight.pending.top}
          onTap={highlight.openSheet}
        />
      ) : null}
      {highlight.pending && highlight.sheetOpen ? (
        <HighlightSheet
          quote={highlight.pending.quote}
          saving={highlight.saving}
          error={highlight.error}
          onSave={(note) => void highlight.save(note)}
          onCancel={highlight.cancel}
        />
      ) : null}
      <MemoryPrompt
        open={memPrompt !== null}
        headroom={memPrompt?.headroom ?? null}
        serverRefused={memPrompt?.serverRefused ?? false}
        onStartAnyway={() => {
          const p = memPrompt?.pending;
          setMemPrompt(null);
          if (!p) return;
          bypassHeadroomRef.current = true;
          void sendMessage(p.text, p.offRecord);
        }}
        onQueue={async () => {
          const p = memPrompt?.pending;
          if (!p) return;
          try {
            // A brand-new compose has no session yet, so queueing has to mint
            // one first — otherwise there'd be nothing for the dispatcher to
            // send into when a slot opens.
            let conv = convRef.current;
            if (!conv) {
              const created = await createSession(p.text.slice(0, 40), false);
              conv = created.id;
              convRef.current = conv;
            }
            await enqueueConversation(conv, p.text);
            setMemPrompt(null);
            setSendError('Queued — it starts when there’s room.');
          } catch (err) {
            setSendError(err instanceof Error ? err.message : 'Could not queue that.');
          }
        }}
        onClose={() => {
          // Give her words back. A refusal that silently eats the message is
          // the one outcome this prompt exists to prevent.
          const p = memPrompt?.pending;
          setMemPrompt(null);
          if (p) composerBox.fillIfEmpty(p.text);
        }}
      />
    </div>
  );
}
